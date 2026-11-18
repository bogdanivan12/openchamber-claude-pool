import type { Account } from "./accounts.ts";
import type { AccountState, PoolState, WindowState } from "./state.ts";

export type RouteInput = {
  accounts: Account[];
  state: PoolState;
  threshold: number;
  now: number;
  current?: string;
  exclude?: ReadonlySet<string>;
};
export type RouteResult = { kind: "account"; account: Account } | { kind: "none"; retryAt: number | null };

const liveWindows = (st: AccountState | undefined, now: number): WindowState[] =>
  Object.values(st?.windows ?? {}).filter(
    (w): w is WindowState => !!w && (w.resetsAt === null || w.resetsAt > now),
  );

export function isAvailable(account: Account, st: AccountState | undefined, threshold: number, now: number): boolean {
  if (!account.enabled || st?.needsLogin) return false;
  if (st?.limitedUntil != null && st.limitedUntil > now) return false;
  return liveWindows(st, now).every((w) => w.usedPercent < threshold);
}

export function headroom(st: AccountState | undefined, threshold: number, now: number): number {
  return Math.min(threshold, ...liveWindows(st, now).map((w) => threshold - w.usedPercent));
}

export function nextAvailableAt(account: Account, st: AccountState | undefined, threshold: number, now: number): number | null {
  if (!account.enabled || st?.needsLogin) return null;
  let at = now;
  if (st?.limitedUntil != null && st.limitedUntil > at) at = st.limitedUntil;
  for (const w of liveWindows(st, now)) {
    if (w.usedPercent < threshold) continue;
    if (w.resetsAt === null) return null; // full with no known reset
    at = Math.max(at, w.resetsAt);
  }
  return at;
}

export function route(input: RouteInput): RouteResult {
  const { accounts, state, threshold, now, current, exclude } = input;
  const candidates = accounts.filter((a) => !exclude?.has(a.id));
  const available = candidates.filter((a) => isAvailable(a, state.accounts[a.id], threshold, now));
  const sticky = current ? available.find((a) => a.id === current) : undefined;
  if (sticky) return { kind: "account", account: sticky };
  if (available.length > 0) {
    const best = [...available].sort(
      (a, b) =>
        headroom(state.accounts[b.id], threshold, now) - headroom(state.accounts[a.id], threshold, now) ||
        a.order - b.order,
    )[0];
    return { kind: "account", account: best };
  }
  const times = candidates
    .map((a) => nextAvailableAt(a, state.accounts[a.id], threshold, now))
    .filter((t): t is number => t !== null);
  return { kind: "none", retryAt: times.length ? Math.min(...times) : null };
}
