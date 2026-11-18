import type { QuotaProviderUsageData, QuotaProviderWindow } from "@openchamber/sdk";
import type { Account } from "../../shared/accounts.ts";
import { route } from "../../shared/router.ts";
import type { PoolState, WindowState } from "../../shared/state.ts";
import type { UsageRead } from "./usage.ts";

const FIVE_H = 5 * 3600;
const SEVEN_D = 7 * 24 * 3600;

const win = (w: WindowState | undefined, seconds: number, now: number, label?: string): QuotaProviderWindow | undefined => {
  if (!w) return undefined;
  const expired = w.resetsAt !== null && w.resetsAt <= now;
  return {
    usedPercent: expired ? 0 : w.usedPercent,
    windowSeconds: seconds,
    resetAt: expired ? null : w.resetsAt,
    ...(label ? { valueLabel: label } : {}),
  };
};

function windowsOf(st: PoolState["accounts"][string] | undefined, now: number, label?: string): Record<string, QuotaProviderWindow> {
  const out: Record<string, QuotaProviderWindow> = {};
  const h = win(st?.windows.five_hour, FIVE_H, now, label);
  const d = win(st?.windows.seven_day, SEVEN_D, now, label);
  if (h) out["5h"] = h;
  if (d) out["7d"] = d;
  return out;
}

function planSummary(reads: Record<string, UsageRead>, accounts: Account[]): string | null {
  const counts = new Map<string, number>();
  for (const a of accounts) {
    const plan = reads[a.id]?.plan ?? a.plan;
    if (!plan) continue;
    const name = plan.charAt(0).toUpperCase() + plan.slice(1);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts.size ? [...counts].map(([n, c]) => `${n} ×${c}`).join(", ") : null;
}

export function buildQuotaAnswer(input: {
  accounts: Account[];
  state: PoolState;
  threshold: number;
  now: number;
  reads: Record<string, UsageRead>;
}): QuotaProviderUsageData {
  const { accounts, state, threshold, now, reads } = input;
  if (accounts.length === 0) {
    return { ok: false, configured: true, error: "No Claude accounts yet. Add one in the Claude Pool panel.", usage: null };
  }
  const models: Record<string, { windows: Record<string, QuotaProviderWindow> }> = {};
  for (const a of accounts.slice(0, 64)) {
    const st = state.accounts[a.id];
    const windows = windowsOf(st, now);
    if (Object.keys(windows).length === 0 && !st?.needsLogin) continue;
    const name = st?.needsLogin ? `${a.label} (sign in again)` : st?.limitedUntil && st.limitedUntil > now ? `${a.label} (limited)` : a.label;
    models[name] = { windows };
  }
  const hasData = Object.values(models).some((m) => Object.keys(m.windows).length > 0);
  if (!hasData) {
    const firstError = Object.values(reads).find((r): r is UsageRead & { ok: false } => !r.ok)?.error ?? "No usage data yet.";
    return { ok: false, configured: true, error: firstError.slice(0, 2000), planLabel: planSummary(reads, accounts), usage: null };
  }
  const routed = route({ accounts, state, threshold, now });
  const top = routed.kind === "account" ? routed.account : accounts[0];
  return {
    ok: true,
    configured: true,
    planLabel: planSummary(reads, accounts),
    usage: { windows: windowsOf(state.accounts[top.id], now, top.label), models },
  };
}
