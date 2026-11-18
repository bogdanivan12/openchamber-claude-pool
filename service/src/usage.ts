import type { Account } from "../../shared/accounts.ts";
import { enabledAccounts, readAccounts } from "../../shared/accounts.ts";
import { readCredentialDetailed as defaultReadDetailed, type CredentialRead } from "../../shared/creds.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { recordWindow, setNeedsLogin, updateState } from "../../shared/state.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

type Win = { usedPercent: number; resetsAt: number | null };
export type UsageRead =
  | { ok: true; windows: Partial<Record<"five_hour" | "seven_day", Win>>; plan: string | null }
  | { ok: false; error: string; needsLogin?: boolean; plan: string | null };

export type UsageDeps = {
  fetch?: typeof fetch;
  readCredentialDetailed?: (configDir: string) => Promise<CredentialRead>;
  /** Simple form (null = not found); used by tests and callers that do not classify errors. */
  readCredential?: (configDir: string) => Promise<CredentialRead["cred"]>;
  now?: () => number;
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
  if ((cooldownUntil.get(account.id) ?? 0) > now) return { ok: false, plan, error: `${account.label}: Anthropic rate-limited usage reads; retrying soon.` };
  let res: Response;
  try {
    res = await doFetch(USAGE_URL, { headers: { authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": BETA }, signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    return { ok: false, plan, error: `${account.label}: ${err instanceof Error ? err.message : "request failed"}` };
  }
  if (res.status === 429) {
    const h = res.headers.get("retry-after");
    const ra = h === null || h.trim() === "" ? NaN : Number(h);
    cooldownUntil.set(account.id, now + (Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS));
    return { ok: false, plan, error: `${account.label}: Anthropic rate-limited usage reads; retrying soon.` };
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

export async function refreshAllUsage(dataDir: string = poolDataDir(), deps: UsageDeps = {}): Promise<Record<string, UsageRead>> {
  const accounts = enabledAccounts(readAccounts(dataDir));
  const reads = await Promise.all(accounts.map((a) => readAccountUsage(a, deps)));
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
      }
    });
  }, dataDir, now);
  return out;
}

export function resetUsageCooldownsForTests(): void {
  cooldownUntil.clear();
}
