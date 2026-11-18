import { findByConfigDir, readAccounts } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { fractionToPercent, markLimited, recordWindow, updateState, windowNameFromRateLimitType } from "../../shared/state.ts";
import { setRateLimitListener, type ClaudeRateLimitState, type RateLimitWriteSource } from "./rate-limit.js";
import { log } from "./log.js";

export function applyRateLimitToPool(configDir: string | undefined, rl: ClaudeRateLimitState, source: RateLimitWriteSource, dataDir: string = poolDataDir()): void {
  const account = findByConfigDir(readAccounts(dataDir), configDir);
  if (!account) return;
  const name = windowNameFromRateLimitType(rl.rateLimitType);
  // Only a real SDK event carries fresh window data; error text and self-heal re-save stale fields.
  const hasWindow = source === "event" && name !== undefined && typeof rl.utilization === "number";
  const limited = source !== "heal" && rl.limited && typeof rl.limitedUntil === "number" && rl.limitedUntil > Date.now();
  if (!hasWindow && !limited) return;
  updateState((s) => {
    if (hasWindow) {
      recordWindow(s, account.id, name!, {
        usedPercent: fractionToPercent(rl.utilization!),
        resetsAt: rl.resetsAt ?? null,
        updatedAt: rl.updatedAt,
      });
    }
    if (limited) markLimited(s, account.id, rl.limitedUntil!);
  }, dataDir);
}

let installedFor: string | undefined;
export function installPoolStateBridge(dataDir: string = poolDataDir()): void {
  if (installedFor === dataDir) return;
  installedFor = dataDir;
  setRateLimitListener((configDir, state, source) => {
    try {
      applyRateLimitToPool(configDir, state, source, dataDir);
    } catch (err) {
      log.warn("[claude-pool] could not record a rate limit in state.json", err instanceof Error ? err.message : err);
    }
  });
}
