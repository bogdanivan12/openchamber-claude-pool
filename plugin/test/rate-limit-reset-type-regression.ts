/**
 * Regression: a rate_limit_event for another window must not inherit the
 * previous window's reset time (a 5h window showing the weekly reset).
 * Run: bun plugin/test/rate-limit-reset-type-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "rate-limit-type-"));
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
const { recordRateLimitInfo } = await import("../src/rate-limit.ts");

const weekly = recordRateLimitInfo({ status: "allowed", rateLimitType: "seven_day", resetsAt: 2_000_000_000 });
assert.equal(weekly?.resetsAt, 2_000_000_000_000);

// Same window, no resetsAt: the known reset is kept.
const sameWindow = recordRateLimitInfo({ status: "allowed", rateLimitType: "seven_day" });
assert.equal(sameWindow?.resetsAt, 2_000_000_000_000);

// Another window, no resetsAt: the weekly reset must not leak into it.
const fiveHour = recordRateLimitInfo({ status: "allowed", rateLimitType: "five_hour" });
assert.equal(fiveHour?.rateLimitType, "five_hour");
assert.equal(fiveHour?.resetsAt, undefined);

// An event with no type at all keeps what it had.
recordRateLimitInfo({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1_900_000_000 });
const untyped = recordRateLimitInfo({ status: "allowed" });
assert.equal(untyped?.resetsAt, 1_900_000_000_000);
console.log("rate-limit-reset-type-regression: ok");
