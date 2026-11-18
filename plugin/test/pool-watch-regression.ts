/**
 * Regression: the accounts watcher is defensive, and the session->provider map
 * is shared and bounded.
 * Run: bun plugin/test/pool-watch-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { watchAccounts, rememberSessionProvider, providerForSession } = await import("../src/pool.ts");

// A data dir that is an existing file: mkdir/watch fail, no throw, callable stop.
const root = mkdtempSync(join(tmpdir(), "pool-watch-"));
const filePath = join(root, "not-a-dir");
writeFileSync(filePath, "x");
const stopBroken = watchAccounts(() => assert.fail("must not fire"), join(filePath, "sub"));
assert.equal(typeof stopBroken, "function");
stopBroken();
stopBroken();

// Real dir: debounced single onChange after a rewrite, none after stop().
const dir = mkdtempSync(join(tmpdir(), "pool-watch-dir-"));
let fired = 0;
const stop = watchAccounts(() => { fired++; }, dir);
writeFileSync(join(dir, "accounts.json"), "1");
writeFileSync(join(dir, "accounts.json"), "2");
await new Promise((r) => setTimeout(r, 800));
assert.equal(fired, 1, "debounced to one call");
stop();
stop();
writeFileSync(join(dir, "accounts.json"), "3");
await new Promise((r) => setTimeout(r, 800));
assert.equal(fired, 1, "no call after stop");

// Session provider map
assert.equal(providerForSession("nope"), undefined);
for (let i = 0; i < 501; i++) rememberSessionProvider(`s${i}`, `claude-pool-${i}`);
assert.equal(providerForSession("s0"), undefined, "oldest evicted");
assert.equal(providerForSession("s500"), "claude-pool-500");
assert.equal(providerForSession("s1"), "claude-pool-1");
rememberSessionProvider("s1", "claude-pool-x"); // refresh moves s1 to newest
rememberSessionProvider("s501", "claude-pool-501"); // evicts s2, not s1
assert.equal(providerForSession("s1"), "claude-pool-x", "refreshed key survives");
assert.equal(providerForSession("s2"), undefined);

console.log("ok — pool watch regression passed");
process.exit(0);
