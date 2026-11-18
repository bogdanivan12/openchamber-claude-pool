import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolveClaudeCli } from "../../plugin/src/executable-path.ts";
import { MAX_THRESHOLD, MIN_THRESHOLD, enabledAccounts, newAccountId, readAccounts, updateAccounts, type Account } from "../../shared/accounts.ts";
import { readCredential } from "../../shared/creds.ts";
import { accountsFile, isInsidePoolAccounts, normalizeDir, poolDataDir, sameDir } from "../../shared/paths.ts";
import { isAvailable, route } from "../../shared/router.ts";
import { activeConversations, readState } from "../../shared/state.ts";
import { logoutDir, readAuthStatus } from "./auth-status.ts";
import type { Route } from "./http.ts";
import { findImportCandidates } from "./import.ts";

const MAX_LABEL = 40;
const NOT_SUBSCRIPTION = "not signed in to a Claude subscription (API-key and third-party logins are not supported)";
export const NAME_TAKEN = "Another account already uses this name";

class NameTakenError extends Error {}

/** The request body as a plain object; an empty body is `{}`; null if it is JSON of another shape. Bad JSON throws SyntaxError (the server answers 400). */
export function bodyObject(r: { body: string }): Record<string, unknown> | null {
  const value: unknown = r.body ? JSON.parse(r.body) : {};
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
export const NOT_OBJECT = { status: 400, body: { error: "Expected a JSON object" } };
export const bad = (message: string) => ({ status: 400, body: { error: message } });
const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether another account (not `exceptId`) already uses `label`, ignoring case and surrounding spaces. */
export const labelTaken = (accounts: readonly Pick<Account, "id" | "label">[], label: string, exceptId?: string): boolean =>
  accounts.some((a) => a.id !== exceptId && sameLabel(a.label, label));

/** `base`, or `base 2`, `base 3`... the first one no other account uses; always <= 40 chars. */
export function uniqueLabel(base: string, taken: string[]): string {
  const start = base.trim().slice(0, MAX_LABEL).trim();
  let label = start;
  for (let n = 2; taken.some((t) => sameLabel(t, label)); n++) {
    const suffix = ` ${n}`;
    label = start.slice(0, MAX_LABEL - suffix.length).trimEnd() + suffix;
  }
  return label;
}

export function accountRoutes(deps: {
  dataDir?: string;
  home?: string;
  authStatus?: typeof readAuthStatus;
  hasCredential?: (dir: string) => Promise<boolean>;
  cliFound?: () => Promise<boolean>;
  logout?: (dir: string) => Promise<void>;
  rm?: (path: string) => void;
  /** Refreshes real usage (5h/7d) before the list is answered; throttled. Absent = no refresh (tests). */
  refreshUsage?: () => Promise<unknown>;
} = {}): Record<string, Route> {
  let lastRefresh = 0;
  const REFRESH_EVERY_MS = 45_000;
  const cliFound = deps.cliFound ?? (async () => (await resolveClaudeCli(process.env)) !== null);
  const dataDir = deps.dataDir ?? poolDataDir();
  const home = deps.home ?? homedir();
  const authStatus = deps.authStatus ?? readAuthStatus;
  const hasCredential = deps.hasCredential ?? (async (dir: string) => (await readCredential(dir)) !== null);
  const logout = deps.logout ?? logoutDir;
  const rm = deps.rm ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  return {
    "GET /api/accounts": async () => {
      if (deps.refreshUsage && Date.now() - lastRefresh > REFRESH_EVERY_MS) {
        lastRefresh = Date.now();
        try { await deps.refreshUsage(); } catch { /* keep the last known numbers */ }
      }
      const found = await cliFound();
      const file = readAccounts(dataDir);
      const state = readState(dataDir);
      const choice = route({ accounts: enabledAccounts(file), state, threshold: file.threshold, now: Date.now() });
      const nextChat = choice.kind === "account" ? choice.account.id : null;
      // "In use" = the account has conversations with a request in the last few minutes.
      const activeBy = activeConversations(state, Date.now());
      return {
        status: 200,
        body: {
          threshold: file.threshold,
          cliFound: found,
          recoveredBackup: existsSync(`${accountsFile(dataDir)}.bak`),
          accounts: [...file.accounts].sort((a, b) => a.order - b.order).map((a) => ({
            ...a,
            state: state.accounts[a.id] ?? null,
            poolActive: (activeBy[a.id] ?? 0) > 0,
            activeChats: activeBy[a.id] ?? 0,
            nextChat: a.id === nextChat,
            available: isAvailable(a, state.accounts[a.id], file.threshold, Date.now()),
            canDeleteLogin: isInsidePoolAccounts(a.configDir, dataDir),
          })),
        },
      };
    },

    "POST /api/accounts/ack-backup": () => {
      const bak = `${accountsFile(dataDir)}.bak`;
      if (existsSync(bak)) {
        try { renameSync(bak, `${bak}.ack-${Date.now()}`); } catch (err) {
          return { status: 500, body: { error: err instanceof Error ? err.message : "could not acknowledge the backup" } };
        }
      }
      return { status: 200, body: { ok: true } };
    },

    "GET /api/import-candidates": async () => ({
      status: 200,
      body: { candidates: await findImportCandidates({ home, existing: readAccounts(dataDir).accounts.map((a) => a.configDir), hasCredential }) },
    }),

    "POST /api/import": async (r) => {
      const body = bodyObject(r);
      if (!body) return NOT_OBJECT;
      const dirs: unknown = body.configDirs;
      if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string")) return bad("configDirs must be a list of folders");
      const added: Account[] = [];
      const skipped: { configDir: string; reason: string }[] = [];
      for (const raw of dirs as string[]) {
        if (!raw.trim()) return bad("configDirs must not contain empty folders");
        const dir = normalizeDir(raw, home);
        try {
          const taken = (f: { accounts: Account[] }) => f.accounts.some((a) => sameDir(a.configDir, dir, home));
          if (taken(readAccounts(dataDir))) {
            skipped.push({ configDir: dir, reason: "already in the pool" });
            continue;
          }
          const info = await authStatus(dir);
          if (!info.loggedIn) {
            skipped.push({ configDir: dir, reason: NOT_SUBSCRIPTION });
            continue;
          }
          let raced = false;
          const next = updateAccounts((f) => {
            // Re-checked under the lock: a concurrent import may have added this dir meanwhile.
            if (taken(f)) { raced = true; return; }
            const id = newAccountId(f.accounts.map((a) => a.id));
            const base = info.email?.split("@")[0]?.trim() || `account ${f.accounts.length + 1}`;
            const label = uniqueLabel(base, f.accounts.map((a) => a.label));
            f.accounts.push({ id, label, configDir: dir, order: f.accounts.length, enabled: true, ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) });
          }, dataDir);
          if (raced) skipped.push({ configDir: dir, reason: "already in the pool" });
          else added.push(next.accounts.at(-1)!);
        } catch (err) {
          skipped.push({ configDir: dir, reason: err instanceof Error ? err.message : "import failed" });
        }
      }
      return { status: 200, body: { added, skipped } };
    },

    "PATCH /api/accounts/:id": (r) => {
      const id = r.query.get("id")!;
      const patch = bodyObject(r);
      if (!patch) return NOT_OBJECT;
      if ("label" in patch && typeof patch.label !== "string") return bad("Name must be text");
      if ("enabled" in patch && typeof patch.enabled !== "boolean") return bad("enabled must be true or false");
      const label = typeof patch.label === "string" ? patch.label.trim() : undefined;
      if (label !== undefined && (label.length < 1 || label.length > MAX_LABEL)) return bad(`Name must be 1 to ${MAX_LABEL} characters`);
      let found: Account | undefined;
      try {
        updateAccounts((f) => {
          found = f.accounts.find((a) => a.id === id);
          if (!found) return;
          if (label !== undefined) {
            if (labelTaken(f.accounts, label, id)) throw new NameTakenError(NAME_TAKEN);
            found.label = label;
          }
          if (typeof patch.enabled === "boolean") found.enabled = patch.enabled;
        }, dataDir);
      } catch (err) {
        if (err instanceof NameTakenError) return bad(err.message);
        throw err;
      }
      return found ? { status: 200, body: found } : { status: 404, body: { error: "no such account" } };
    },

    "POST /api/accounts/reorder": (r) => {
      const body = bodyObject(r);
      if (!body) return NOT_OBJECT;
      const ids: unknown = body.ids;
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) return bad("ids must be a list of account ids");
      updateAccounts((f) => {
        const rank = new Map((ids as string[]).map((id, i) => [id, i]));
        f.accounts.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.order - b.order);
        f.accounts.forEach((a, i) => (a.order = i));
      }, dataDir);
      return { status: 200, body: { ok: true } };
    },

    "DELETE /api/accounts/:id": async (r) => {
      const id = r.query.get("id")!;
      let removed: Account | undefined;
      updateAccounts((f) => {
        removed = f.accounts.find((a) => a.id === id);
        f.accounts = f.accounts.filter((a) => a.id !== id);
        f.accounts.forEach((a, i) => (a.order = i));
      }, dataDir);
      if (!removed) return { status: 404, body: { error: "no such account" } };
      if (r.query.get("deleteLogin") === "1" && isInsidePoolAccounts(removed.configDir, dataDir)) {
        // Removes the Keychain item the dir leaves behind; best effort, never blocks the delete.
        try { await logout(removed.configDir); } catch {}
        try {
          rm(removed.configDir);
          return { status: 200, body: { ok: true, deletedLogin: true } };
        } catch (err) {
          // The account is already gone from the pool; report the leftover folder instead of failing.
          return { status: 200, body: { ok: true, deletedLogin: false, warning: err instanceof Error ? err.message : "could not delete the login folder" } };
        }
      }
      return { status: 200, body: { ok: true, deletedLogin: false } };
    },

    "PUT /api/settings": (r) => {
      const body = bodyObject(r);
      if (!body) return NOT_OBJECT;
      const t = body.threshold;
      if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_THRESHOLD || t > MAX_THRESHOLD) return bad(`threshold must be ${MIN_THRESHOLD}..${MAX_THRESHOLD}`);
      const f = updateAccounts((file) => { file.threshold = t; }, dataDir);
      return { status: 200, body: { threshold: f.threshold } };
    },
  };
}
