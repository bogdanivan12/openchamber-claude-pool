import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolveClaudeCli } from "../../plugin/src/executable-path.ts";
import { MAX_THRESHOLD, MIN_THRESHOLD, enabledAccounts, newAccountId, readAccounts, updateAccounts, type Account } from "../../shared/accounts.ts";
import { readCredential } from "../../shared/creds.ts";
import { accountsFile, isInsidePoolAccounts, normalizeDir, poolDataDir } from "../../shared/paths.ts";
import { route } from "../../shared/router.ts";
import { readState } from "../../shared/state.ts";
import { logoutDir, readAuthStatus } from "./auth-status.ts";
import type { Route } from "./http.ts";
import { findImportCandidates } from "./import.ts";

const MAX_LABEL = 40;
const NAME_TAKEN = "Another account already uses this name";

const json = (r: { body: string }) => (r.body ? JSON.parse(r.body) : {});
const bad = (message: string) => ({ status: 400, body: { error: message } });
const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `base`, or `base 2`, `base 3`... the first one no other account uses; always <= 40 chars. */
function uniqueLabel(base: string, taken: string[]): string {
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
} = {}): Record<string, Route> {
  const cliFound = deps.cliFound ?? (async () => (await resolveClaudeCli(process.env)) !== null);
  const dataDir = deps.dataDir ?? poolDataDir();
  const home = deps.home ?? homedir();
  const authStatus = deps.authStatus ?? readAuthStatus;
  const hasCredential = deps.hasCredential ?? (async (dir: string) => (await readCredential(dir)) !== null);
  const logout = deps.logout ?? logoutDir;

  return {
    "GET /api/accounts": async () => {
      const found = await cliFound();
      const file = readAccounts(dataDir);
      const state = readState(dataDir);
      const choice = route({ accounts: enabledAccounts(file), state, threshold: file.threshold, now: Date.now() });
      const active = choice.kind === "account" ? choice.account.id : null;
      return {
        status: 200,
        body: {
          threshold: file.threshold,
          cliFound: found,
          recoveredBackup: existsSync(`${accountsFile(dataDir)}.bak`),
          accounts: [...file.accounts].sort((a, b) => a.order - b.order).map((a) => ({
            ...a,
            state: state.accounts[a.id] ?? null,
            poolActive: a.id === active,
            canDeleteLogin: isInsidePoolAccounts(a.configDir, dataDir),
          })),
        },
      };
    },

    "GET /api/import-candidates": async () => ({
      status: 200,
      body: { candidates: await findImportCandidates({ home, existing: readAccounts(dataDir).accounts.map((a) => a.configDir), hasCredential }) },
    }),

    "POST /api/import": async (r) => {
      const dirs: unknown = json(r).configDirs;
      if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string")) return bad("configDirs must be a list of folders");
      const added: Account[] = [];
      const skipped: { configDir: string; reason: string }[] = [];
      for (const raw of dirs as string[]) {
        if (!raw.trim()) return bad("configDirs must not contain empty folders");
        const dir = normalizeDir(raw, home);
        if (readAccounts(dataDir).accounts.some((a) => normalizeDir(a.configDir, home) === dir)) {
          skipped.push({ configDir: dir, reason: "already in the pool" });
          continue;
        }
        const info = await authStatus(dir);
        if (!info.loggedIn) {
          skipped.push({ configDir: dir, reason: "not signed in to a Claude subscription" });
          continue;
        }
        const next = updateAccounts((f) => {
          const id = newAccountId(f.accounts.map((a) => a.id));
          const base = info.email?.split("@")[0] || `account ${f.accounts.length + 1}`;
          const label = uniqueLabel(base, f.accounts.map((a) => a.label));
          f.accounts.push({ id, label, configDir: dir, order: f.accounts.length, enabled: true, ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) });
        }, dataDir);
        added.push(next.accounts.at(-1)!);
      }
      return { status: 200, body: { added, skipped } };
    },

    "PATCH /api/accounts/:id": (r) => {
      const id = r.query.get("id")!;
      const patch = json(r) as { label?: unknown; enabled?: unknown };
      const label = typeof patch.label === "string" ? patch.label.trim() : undefined;
      if (label !== undefined && (label.length < 1 || label.length > MAX_LABEL)) return bad(`Name must be 1 to ${MAX_LABEL} characters`);
      let found: Account | undefined;
      try {
        updateAccounts((f) => {
          found = f.accounts.find((a) => a.id === id);
          if (!found) return;
          if (label !== undefined) {
            if (f.accounts.some((a) => a.id !== id && sameLabel(a.label, label))) throw new Error(NAME_TAKEN);
            found.label = label;
          }
          if (typeof patch.enabled === "boolean") found.enabled = patch.enabled;
        }, dataDir);
      } catch (err) {
        return bad(err instanceof Error ? err.message : "invalid change");
      }
      return found ? { status: 200, body: found } : { status: 404, body: { error: "no such account" } };
    },

    "POST /api/accounts/reorder": (r) => {
      const ids: unknown = json(r).ids;
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
      let deletedLogin = false;
      if (r.query.get("deleteLogin") === "1" && isInsidePoolAccounts(removed.configDir, dataDir)) {
        // Removes the Keychain item the dir leaves behind; best effort, never blocks the delete.
        try { await logout(removed.configDir); } catch {}
        rmSync(removed.configDir, { recursive: true, force: true });
        deletedLogin = true;
      }
      return { status: 200, body: { ok: true, deletedLogin } };
    },

    "PUT /api/settings": (r) => {
      const t = json(r).threshold;
      if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_THRESHOLD || t > MAX_THRESHOLD) return bad(`threshold must be ${MIN_THRESHOLD}..${MAX_THRESHOLD}`);
      const f = updateAccounts((file) => { file.threshold = t; }, dataDir);
      return { status: 200, body: { threshold: f.threshold } };
    },
  };
}
