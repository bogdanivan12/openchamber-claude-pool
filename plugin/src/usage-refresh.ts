import type { Account } from "../../shared/accounts.ts";
import { readState } from "../../shared/state.ts";
import { STALE_USAGE_MS, accountsToFreshen, refreshUsage, type UsageDeps } from "../../shared/usage.ts";
import { log } from "./log.js";
import { setUsageFreshener, type UsageFreshener } from "./pool-proxy.js";

/** How long a pool request waits for fresh usage before it routes on the numbers it has. */
export const FRESHEN_BUDGET_MS = 1500;
/** A read that outlives the budget keeps going in the background and still lands in state.json. */
const READ_TIMEOUT_MS = 5000;

/**
 * Re-reads usage of the accounts a pool request may land on (see `accountsToFreshen`), at most once
 * per STALE_USAGE_MS per account, joining a read already in flight. Never throws and never waits
 * longer than the budget.
 */
export function makeUsageFreshener(deps: UsageDeps = {}, budgetMs: number = FRESHEN_BUDGET_MS): UsageFreshener {
  const lastAttempt = new Map<string, number>();
  const inFlight = new Map<string, Promise<unknown>>();
  return async (accounts: Account[], dataDir: string, newConversation: boolean) => {
    const now = (deps.now ?? Date.now)();
    const due = accountsToFreshen(accounts, readState(dataDir), now, { newConversation })
      .filter((a) => inFlight.has(a.id) || now - (lastAttempt.get(a.id) ?? -Infinity) > STALE_USAGE_MS);
    if (due.length === 0) return;
    const waits = due.map((a) => {
      let p = inFlight.get(a.id);
      if (!p) {
        lastAttempt.set(a.id, now);
        p = refreshUsage([a], dataDir, { ...deps, timeoutMs: deps.timeoutMs ?? READ_TIMEOUT_MS })
          .catch((err) => log.warn("[claude-pool] usage refresh before routing failed", err instanceof Error ? err.message : err))
          .finally(() => inFlight.delete(a.id));
        inFlight.set(a.id, p);
      }
      return p;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([Promise.all(waits), budget]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** CLAUDE_POOL_USAGE_REFRESH=off turns it off (the plugin test runner does, so tests never touch real logins). */
export function installUsageFreshener(): void {
  setUsageFreshener(process.env.CLAUDE_POOL_USAGE_REFRESH === "off" ? null : makeUsageFreshener());
}
