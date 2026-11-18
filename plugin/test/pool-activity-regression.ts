/**
 * Regression: a streaming response keeps its conversation active (heartbeat) and
 * renews it once more when the body ends; bytes pass through untouched; a
 * cancelled body stops the heartbeat.
 * Run: bun plugin/test/pool-activity-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pool-activity-"));
const { bindConversation, readState, updateState } = await import("../../shared/state.ts");
const { trackActivity } = await import("../src/pool-proxy.ts");

const activeAt = () => readState(dir).conversations.s1?.activeAt ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slow = (chunks: string[], gapMs: number) =>
  new Response(new ReadableStream<Uint8Array>({
    async pull(c) {
      const next = chunks.shift();
      if (next === undefined) return c.close();
      await sleep(gapMs);
      c.enqueue(new TextEncoder().encode(next));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });

// 1. heartbeat advances while the body is open, bytes are intact, headers kept
const start = Date.now();
updateState((s) => bindConversation(s, "s1", "aaaaaa", start), dir, start);
await sleep(5);
const t0 = activeAt();
assert.equal(t0, start);
const res = trackActivity(slow(["a", "b", "c", "d"], 60), dir, "s1", 20);
assert.equal(res.headers.get("content-type"), "text/event-stream");
const reader = res.body!.getReader();
await reader.read();
await sleep(50);
const mid = activeAt();
assert.ok(mid > t0, "heartbeat renewed activity during the stream");
let text = "a";
for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
assert.equal(text, "abcd");
const end = activeAt();
assert.ok(end >= mid, "end of stream renews once more");

// 2. heartbeat stops after the body ends
await sleep(80);
assert.equal(activeAt(), end, "no writes after the stream finished");

// 3. cancelling stops the heartbeat
const r2 = trackActivity(slow(["x", "y", "z"], 60), dir, "s1", 20);
const rd2 = r2.body!.getReader();
await rd2.read();
await rd2.cancel();
const afterCancel = activeAt();
await sleep(80);
assert.equal(activeAt(), afterCancel, "no writes after cancel");

// 4. no key or no body: returned as is
const plain = new Response(null, { status: 204 });
assert.equal(trackActivity(plain, dir, "s1"), plain);
const keyless = slow(["q"], 1);
assert.equal(trackActivity(keyless, dir, undefined), keyless);

console.log("pool-activity-regression passed");
process.exit(0);
