/**
 * Regression: a hard limit AFTER output was already streamed cannot become a
 * 429 (the HTTP head is committed). The pool answers 200 with the existing
 * retryable stream error, marks the account limited, and OpenCode's retry of
 * the same session lands on the next account.
 * Run: bun plugin/test/pool-midstream-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "pool-midstream-"));
process.env.CLAUDE_POOL_HOME = home;
const B_DIR = mkdtempSync(join(tmpdir(), "pool-mid-b-"));
const C_DIR = mkdtempSync(join(tmpdir(), "pool-mid-c-"));

const { updateAccounts } = await import("../../shared/accounts.ts");
const { readState, updateState, recordWindow } = await import("../../shared/state.ts");
updateAccounts((f) => {
  f.accounts.push({ id: "bbbbbb", label: "b", configDir: B_DIR, order: 0, enabled: true });
  f.accounts.push({ id: "cccccc", label: "c", configDir: C_DIR, order: 1, enabled: true });
}, home);
const now = Date.now();
updateState((s) => {
  recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 10, resetsAt: now + 3600_000, updatedAt: now });
  recordWindow(s, "cccccc", "five_hour", { usedPercent: 40, resetsAt: now + 3600_000, updatedAt: now });
}, home);

const { port, proxy } = await startMockedProxy("pool-midstream");
const seenDirs: Array<string | undefined> = [];
proxy.setClaudeQueryStarter(async (params: any) => {
  const dir = params.env.CLAUDE_CONFIG_DIR as string | undefined;
  seenDirs.push(dir);
  if (dir === B_DIR) {
    return mockHandle((async function* () {
      yield textDelta("partial answer");
      yield { type: "result", is_error: true, subtype: "error_during_execution", result: "You've hit your session limit · resets 11pm (UTC)" };
    })());
  }
  return mockHandle((async function* () {
    yield textDelta("from c");
    yield { type: "result", is_error: false, usage: {} };
  })());
});

const send = () =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-claude-session": "s-mid", "x-claude-pool-account": "pool" },
    body: JSON.stringify({ model: "sonnet", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

try {
  let res = await send();
  assert.equal(res.status, 200, "output already streamed: no 429");
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /partial answer/);
  assert.match(text, /claude_session_limit/, "the retryable stream error is sent");
  assert.match(text, /session limit/);
  assert.deepEqual(seenDirs, [B_DIR]);
  assert.ok((readState(home).accounts.bbbbbb?.limitedUntil ?? 0) > Date.now(), "account marked limited from the error");

  // OpenCode retries the same session: the pool now picks the other account.
  res = await send();
  assert.equal(res.status, 200);
  assert.match(await res.text(), /from c/);
  assert.deepEqual(seenDirs, [B_DIR, C_DIR]);
  assert.equal(readState(home).conversations["s-mid"].accountId, "cccccc");
  console.log("pool-midstream-regression: ok");
} finally {
  await proxy.stopProxy();
}
process.exit(0);
