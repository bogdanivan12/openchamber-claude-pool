import { mkdirSync, rmSync } from "node:fs";
import { cancelClaudeCliLogin, startClaudeCliLogin, submitClaudeCliLoginCode } from "../../plugin/src/cli-login.ts";
import { newAccountId, readAccounts, updateAccounts, type Account } from "../../shared/accounts.ts";
import { newAccountDir, poolDataDir } from "../../shared/paths.ts";
import { setNeedsLogin, updateState } from "../../shared/state.ts";
import { NAME_TAKEN, bad, bodyObject, labelTaken, NOT_OBJECT, uniqueLabel } from "./accounts-api.ts";
import { envForDir, logoutDir, readAuthStatus } from "./auth-status.ts";
import type { Route } from "./http.ts";

export type LoginRelay = {
  start(env: Record<string, string | undefined>): Promise<{ state: "awaiting-code"; url: string } | { state: "failed"; message: string }>;
  submit(code: string): Promise<{ ok: true } | { ok: false; message: string }>;
  cancel(): void;
};

export type LoginView =
  | { state: "idle" }
  | { state: "awaiting-code"; url: string; accountId: string | null; label: string }
  | { state: "verifying" }
  | { state: "succeeded"; account: Account; duplicateOf: string | null }
  | { state: "failed"; message: string };

const cliRelay: LoginRelay = {
  start: async (env) => {
    const r = await startClaudeCliLogin({ env });
    return r.state === "awaiting-code" ? r : { state: "failed", message: r.message };
  },
  submit: (code) => submitClaudeCliLoginCode(code),
  cancel: () => cancelClaudeCliLogin(),
};

const MAX_LABEL = 40;
const SIGNED_OUT = { loggedIn: false, email: null, plan: null };

type Pending = { accountId: string | null; id: string; label: string; dir: string; created: boolean };

/**
 * One sign-in at a time (the CLI relay is a singleton). Rules worth knowing:
 * - A pending NEW account owns a pool-created dir; every path that abandons it cancels the relay,
 *   best-effort logs the dir out (Keychain item) and removes it. Re-sign-in of an existing account never does.
 * - The shared state lock is never held across a relay/authStatus await: `updateAccounts`/`updateState` run sequentially after them.
 * - Whoever replaces or clears `pending` owns the cleanup; a handler that finds `pending` changed after an await just returns the current view.
 */
export function loginRoutes(deps: {
  dataDir?: string;
  relay?: LoginRelay;
  authStatus?: typeof readAuthStatus;
  logout?: (dir: string) => Promise<void>;
  rm?: (path: string) => void;
} = {}): Record<string, Route> {
  const dataDir = deps.dataDir ?? poolDataDir();
  const relay = deps.relay ?? cliRelay;
  const authStatus = deps.authStatus ?? readAuthStatus;
  const logout = deps.logout ?? logoutDir;
  const rm = deps.rm ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  let pending: Pending | null = null;
  let view: LoginView = { state: "idle" };

  /** Stops the relay and, for a pool-created dir, logs it out and deletes it. Never throws. */
  const discard = async (p: Pending | null) => {
    try { relay.cancel(); } catch {}
    if (!p?.created) return;
    try { await logout(p.dir); } catch {}
    try { rm(p.dir); } catch {}
  };

  return {
    "GET /api/login": () => ({ status: 200, body: view }),

    "POST /api/login/start": async (r) => {
      const input = bodyObject(r);
      if (!input) return NOT_OBJECT;
      const { label, accountId } = input;
      if (label !== undefined && typeof label !== "string") return bad("Name must be text");
      if (accountId !== undefined && typeof accountId !== "string") return bad("accountId must be text");

      // Validate everything before touching the pending login or the disk.
      let next: Pending;
      if (accountId) {
        const acc = readAccounts(dataDir).accounts.find((a) => a.id === accountId);
        if (!acc) return { status: 404, body: { error: "no such account" } };
        next = { accountId, id: acc.id, label: acc.label, dir: acc.configDir, created: false };
      } else {
        const name = (label ?? "").trim();
        if (!name || name.length > MAX_LABEL) return bad(`Name must be 1 to ${MAX_LABEL} characters`);
        const accounts = readAccounts(dataDir).accounts;
        if (labelTaken(accounts, name)) return bad(NAME_TAKEN);
        const id = newAccountId(accounts.map((a) => a.id));
        const dir = newAccountDir(id, dataDir);
        mkdirSync(dir, { recursive: true });
        next = { accountId: null, id, label: name, dir, created: true };
      }

      const previous = pending;
      pending = next;
      view = { state: "idle" };
      await discard(previous); // also cancels the relay, so the new start never reuses the old child
      let started: Awaited<ReturnType<LoginRelay["start"]>>;
      try {
        started = await relay.start(envForDir(next.dir));
      } catch (err) {
        started = { state: "failed", message: err instanceof Error ? err.message : "Could not start the Claude sign-in." };
      }
      if (pending !== next) return { status: 200, body: view }; // cancelled or replaced meanwhile; that call cleaned up
      if (started.state === "failed") {
        pending = null;
        view = { state: "failed", message: started.message };
        await discard(next);
      } else {
        view = { state: "awaiting-code", url: started.url, accountId: next.accountId, label: next.label };
      }
      return { status: 200, body: view };
    },

    "POST /api/login/code": async (r) => {
      const input = bodyObject(r);
      if (!input) return NOT_OBJECT;
      const p = pending;
      if (!p) return { status: 409, body: { error: "no sign-in in progress" } };
      if (view.state === "verifying") return { status: 409, body: { error: "the code is already being checked" } };
      const code = typeof input.code === "string" ? input.code.trim() : "";
      if (!code) return bad("paste the code from the Claude page");

      view = { state: "verifying" };
      let submitted: Awaited<ReturnType<LoginRelay["submit"]>>;
      try { submitted = await relay.submit(code); } catch (err) {
        submitted = { ok: false, message: err instanceof Error ? err.message : "" };
      }
      const info = await authStatus(p.dir).catch(() => SIGNED_OUT);
      if (pending !== p) return { status: 200, body: view }; // cancelled or replaced while verifying

      if (!submitted.ok && !info.loggedIn) {
        pending = null;
        view = { state: "failed", message: submitted.message || "Claude Code did not accept the code." };
        await discard(p);
        return { status: 200, body: view };
      }

      let duplicateOf: string | null = null;
      let gone = false;
      const file = updateAccounts((f) => {
        duplicateOf = info.email
          ? f.accounts.find((a) => a.id !== p.id && a.email?.toLowerCase() === info.email!.toLowerCase())?.id ?? null
          : null;
        const acc = f.accounts.find((a) => a.id === p.id);
        if (acc) {
          if (info.email) acc.email = info.email;
          if (info.plan) acc.plan = info.plan;
        } else if (p.created) {
          // The name was free at start; another account may have taken it since.
          const label = uniqueLabel(p.label, f.accounts.map((a) => a.label));
          f.accounts.push({ id: p.id, label, configDir: p.dir, order: f.accounts.length, enabled: true, ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) });
        } else {
          gone = true; // the account being signed in again was removed meanwhile; do not resurrect it
        }
      }, dataDir);
      pending = null;
      if (gone) {
        view = { state: "failed", message: "This account was removed while signing in." };
        return { status: 200, body: view };
      }
      updateState((s) => setNeedsLogin(s, p.id, false), dataDir);
      view = { state: "succeeded", account: file.accounts.find((a) => a.id === p.id)!, duplicateOf };
      return { status: 200, body: view };
    },

    "POST /api/login/cancel": async () => {
      const p = pending;
      pending = null;
      view = { state: "idle" };
      await discard(p);
      return { status: 200, body: view };
    },
  };
}
