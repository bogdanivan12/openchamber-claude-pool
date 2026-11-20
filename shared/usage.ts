import type { Account } from "./accounts.ts";
import { enabledAccounts, readAccounts } from "./accounts.ts";
import { readCredentialDetailed as defaultReadDetailed, type CredentialRead } from "./creds.ts";
import { poolDataDir } from "./paths.ts";
import { accountState, readState, recordWindow, setNeedsLogin, updateState, type PoolState } from "./state.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

type Win = { usedPercent: number; resetsAt: number | null };
export type UsageRead =
  | { ok: true; windows: Partial<Record<"five_hour" | "seven_day", Win>>; plan: string | null }
  | { ok: false; error: string; needsLogin?: boolean; plan: string | null; cooldownUntil?: number };

export type UsageDeps = {
  fetch?: typeof fetch;
  readCredentialDetailed?: (configDir: string) => Promise<CredentialRead>;
  /** Simple form (null = not found); used by tests and callers that do not classify errors. */
  readCredential?: (configDir: string) => Promise<CredentialRead["cred"]>;
  now?: () => number;
  /** Per-request timeout of the usage call. */
  timeoutMs?: number;
};

const cooldownUntil = new Map<string, number>();

const toTime = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};
const pct = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);

export function parseUsagePayload(payload: unknown): UsageRead & { ok: true } {
  const p = (payload ?? {}) as Record<string, any>;
  const windows: Partial<Record<"five_hour" | "seven_day", Win>> = {};
  const put = (name: "five_hour" | "seven_day", percent: number | null, reset: unknown) => {
    if (percent !== null) windows[name] = { usedPercent: percent, resetsAt: toTime(reset) };
  };
  if (Array.isArray(p.limits) && p.limits.length > 0) {
    for (const l of p.limits) {
      if (l?.kind === "session") put("five_hour", pct(l.percent), l.resets_at);
      if (l?.kind === "weekly_all") put("seven_day", pct(l.percent), l.resets_at);
    }
  } else {
    put("five_hour", pct(p.five_hour?.utilization), p.five_hour?.resets_at);
    put("seven_day", pct(p.seven_day?.utilization), p.seven_day?.resets_at);
  }
  return { ok: true, windows, plan: null };
}

const coolingDown = (account: Account, plan: string | null) =>
  ({ ok: false as const, plan, error: `${account.label}: Anthropic rate-limited usage reads; retrying soon.` });

export async function readAccountUsage(account: Account, deps: UsageDeps = {}): Promise<UsageRead> {
  const now = (deps.now ?? Date.now)();
  const doFetch = deps.fetch ?? fetch;
  let read: CredentialRead;
  try {
    read = deps.readCredentialDetailed
      ? await deps.readCredentialDetailed(account.configDir)
      : deps.readCredential
        ? await deps.readCredential(account.configDir).then((cred): CredentialRead => (cred ? { cred } : { cred: null, reason: "not-found" }))
        : await defaultReadDetailed(account.configDir);
  } catch (err) {
    return { ok: false, plan: null, error: `${account.label}: could not read the login (${err instanceof Error ? err.message.slice(0, 200) : "unknown error"})` };
  }
  const cred = read.cred;
  if (!cred && read.reason === "error") {
    return { ok: false, plan: null, error: `${account.label}: could not read this account's login (${read.message ?? "unknown error"}). If macOS asked for Keychain access, allow it; reload to retry.` };
  }
  if (!cred) return { ok: false, needsLogin: true, plan: null, error: `No Claude login found (or the Keychain denied access) for ${account.label}. Sign in again in the Claude Pool panel.` };
  const plan = cred.subscriptionType;
  if (cred.expiresAt !== null && cred.expiresAt > 0 && cred.expiresAt <= now) {
    return { ok: false, plan, error: `${account.label}: the token expired; Claude Code renews it on this account's next turn.` };
  }
  if ((cooldownUntil.get(account.id) ?? 0) > now) return coolingDown(account, plan);
  let res: Response;
  try {
    res = await doFetch(USAGE_URL, { headers: { authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": BETA }, signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000) });
  } catch (err) {
    return { ok: false, plan, error: `${account.label}: ${err instanceof Error ? err.message : "request failed"}` };
  }
  if (res.status === 429) {
    const h = res.headers.get("retry-after");
    const ra = h === null || h.trim() === "" ? NaN : Number(h);
    const until = now + (Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS);
    cooldownUntil.set(account.id, until);
    return { ...coolingDown(account, plan), cooldownUntil: until };
  }
  if (res.status === 401) return { ok: false, needsLogin: true, plan, error: `${account.label}: session expired. Sign in again in the Claude Pool panel.` };
  if (res.status === 403) return { ok: false, plan, error: `${account.label}: this login cannot read usage (a setup-token login cannot).` };
  if (!res.ok) return { ok: false, plan, error: `${account.label}: API error ${res.status}` };
  try {
    return { ...parseUsagePayload(await res.json()), plan };
  } catch {
    return { ok: false, plan, error: `${account.label}: unexpected response from Anthropic` };
  }
}

/**
 * Reads usage for the given accounts and records it in state.json. A 429 cooldown is kept in
 * state.json too, so the service and the plugin (separate processes) back off together.
 */
export async function refreshUsage(accounts: Account[], dataDir: string = poolDataDir(), deps: UsageDeps = {}): Promise<Record<string, UsageRead>> {
  const before = readState(dataDir);
  const startedAt = (deps.now ?? Date.now)();
  const reads = await Promise.all(accounts.map((a) => {
    const shared = before.accounts[a.id]?.usageCooldownUntil ?? 0;
    return shared > startedAt ? Promise.resolve<UsageRead>(coolingDown(a, a.plan ?? null)) : readAccountUsage(a, deps);
  }));
  const now = (deps.now ?? Date.now)();
  const out: Record<string, UsageRead> = {};
  // Re-read just before the update, and outside the state lock: a corrupt accounts.json is
  // repaired under that same non-reentrant lock and would wait out its timeout inside the callback.
  const present = new Set(readAccounts(dataDir).accounts.map((a) => a.id));
  updateState((s) => {
    accounts.forEach((a, i) => {
      const r = reads[i];
      out[a.id] = r;
      if (!present.has(a.id)) return;
      if (r.ok) {
        setNeedsLogin(s, a.id, false);
        for (const [name, w] of Object.entries(r.windows)) recordWindow(s, a.id, name as "five_hour" | "seven_day", { ...w!, updatedAt: now });
      } else if (r.needsLogin) {
        setNeedsLogin(s, a.id, true);
      } else if (r.cooldownUntil !== undefined) {
        accountState(s, a.id).usageCooldownUntil = r.cooldownUntil;
      }
    });
  }, dataDir, now);
  return out;
}

export async function refreshAllUsage(dataDir: string = poolDataDir(), deps: UsageDeps = {}): Promise<Record<string, UsageRead>> {
  return refreshUsage(enabledAccounts(readAccounts(dataDir)), dataDir, deps);
}

/** Usage older than this is refreshed before a pool request picks an account. */
export const STALE_USAGE_MS = 2 * 60_000;
/** An account this close to full (either window) gets fresh numbers before it is picked. */
export const NEAR_FULL_PERCENT = 85;

/**
 * The accounts whose usage should be re-read before routing: usable ones (not signed out, not
 * limited, not in a read cooldown) whose numbers are stale or missing, and, unless the
 * conversation is new, only those near full. Far from full, a stale number cannot change the pick
 * for a running conversation, so it is not worth the wait.
 */
export function accountsToFreshen(accounts: Account[], state: PoolState, now: number, opts: { newConversation: boolean }): Account[] {
  return accounts.filter((a) => {
    const st = state.accounts[a.id];
    if (!a.enabled || st?.needsLogin) return false;
    if ((st?.limitedUntil ?? 0) > now || (st?.usageCooldownUntil ?? 0) > now) return false;
    const wins = Object.values(st?.windows ?? {}).filter((w) => !!w);
    if (wins.length === 0) return true;
    const stale = wins.some((w) => now - w.updatedAt > STALE_USAGE_MS);
    if (!stale) return false;
    if (opts.newConversation) return true;
    return wins.some((w) => (w.resetsAt === null || w.resetsAt > now) && w.usedPercent >= NEAR_FULL_PERCENT);
  });
}

export function resetUsageCooldownsForTests(): void {
  cooldownUntil.clear();
}
