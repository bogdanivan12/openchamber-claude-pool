import type { Account } from "../../shared/accounts.ts";
import type { AccountState, WindowName } from "../../shared/state.ts";

export type AccountView = Account & { state: AccountState | null; poolActive: boolean; nextChat?: boolean; available?: boolean; canDeleteLogin: boolean };

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return `${min}m`;
}

export function statusBadge(v: AccountView, now: number): { label: string; tone: "success" | "warning" | "error" | "neutral" } {
  if (!v.enabled) return { label: "Disabled", tone: "neutral" };
  if (v.state?.needsLogin) return { label: "Sign in again", tone: "error" };
  if (v.state?.limitedUntil && v.state.limitedUntil > now) return { label: `Limited · ${duration(v.state.limitedUntil - now)}`, tone: "warning" };
  if (v.poolActive) return { label: "In use now", tone: "success" };
  if (v.nextChat) return { label: "Next for new chats", tone: "neutral" };
  return { label: "Ready", tone: "neutral" };
}

export function windowPercent(st: AccountState | null, name: WindowName, now: number): number {
  const w = st?.windows[name];
  if (!w || (w.resetsAt !== null && w.resetsAt <= now)) return 0;
  return w.usedPercent;
}

export function resetText(resetsAt: number | null, now: number): string {
  return resetsAt === null || resetsAt <= now ? "" : `resets in ${duration(resetsAt - now)}`;
}

/** Mirrors the service's rule (integer 50..100) so the panel can reject early. */
export function validateThreshold(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < 50 || n > 100) return { ok: false, error: "Enter a whole number from 50 to 100." };
  return { ok: true, value: n };
}

export type AccountKind = "use" | "ready" | "out";
/** In use now (green), available (neutral), unavailable because of a limit or sign-in (red). */
export function accountKind(v: AccountView, now: number): { kind: AccountKind; label: string } {
  const unavailable = v.state?.needsLogin || (v.state?.limitedUntil != null && v.state.limitedUntil > now) || v.available === false;
  if (unavailable) return { kind: "out", label: "Unavailable" };
  if (v.poolActive) return { kind: "use", label: "In use now" };
  return { kind: "ready", label: "Available" };
}
