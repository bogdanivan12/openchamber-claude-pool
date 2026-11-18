/**
 * Regression: every rate-limit record the proxy writes lands in state.json
 * under the account whose config dir it came from.
 * Run: bun plugin/test/pool-state-bridge-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pool-bridge-"));
process.env.CLAUDE_POOL_HOME = home;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(home, "rl.json");
const { updateAccounts } = await import("../../shared/accounts.ts");
const { readState } = await import("../../shared/state.ts");
const { installPoolStateBridge } = await import("../src/pool-state-bridge.ts");
const { recordRateLimitInfo, recordRateLimitErrorText } = await import("../src/rate-limit.ts");

const bDir = join(homedir(), ".claude-b-test");
updateAccounts((f) => {
  f.accounts.push({ id: "aaaaaa", label: "a", configDir: "~/.claude", order: 0, enabled: true });
  f.accounts.push({ id: "bbbbbb", label: "b", configDir: bDir, order: 1, enabled: true });
}, home);
installPoolStateBridge(home);

const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
recordRateLimitInfo({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.83, resetsAt: resetsAtSec }, bDir);
let s = readState(home);
assert.equal(s.accounts.bbbbbb.windows.five_hour?.usedPercent, 83);
assert.equal(s.accounts.bbbbbb.windows.five_hour?.resetsAt, resetsAtSec * 1000);

recordRateLimitInfo({ status: "allowed", rateLimitType: "seven_day", utilization: 0.2, resetsAt: resetsAtSec }, undefined);
s = readState(home);
assert.equal(s.accounts.aaaaaa.windows.seven_day?.usedPercent, 20, "undefined dir = default account");

recordRateLimitErrorText("You've hit your session limit · resets 11pm (UTC)", bDir);
s = readState(home);
assert.ok((s.accounts.bbbbbb.limitedUntil ?? 0) > Date.now(), "hard limit marks the account");

recordRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }, "/unknown/dir");
assert.equal(Object.keys(readState(home).accounts).sort().join(","), "aaaaaa,bbbbbb", "unknown dirs are ignored");
console.log("ok — pool state bridge regression passed");
process.exit(0);
