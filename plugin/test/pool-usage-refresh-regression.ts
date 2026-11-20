/**
 * Regression: before a pool request picks an account, usage that is stale is re-read
 * (only for accounts near full, or for every account on a new conversation), within a
 * time budget; a slow read does not hold the request and still lands in state.json.
 * Run: bun plugin/test/pool-usage-refresh-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "pool-usage-refresh-"));
process.env.CLAUDE_POOL_HOME = home;
const A_DIR = mkdtempSync(join(tmpdir(), "pool-ur-a-"));
const B_DIR = mkdtempSync(join(tmpdir(), "pool-ur-b-"));

const { updateAccounts } = await import("../../shared/accounts.ts");
const { readState, updateState, recordWindow, bindConversation } = await import("../../shared/state.ts");
const { setUsageFreshener } = await import("../src/pool-proxy.ts");
const { makeUsageFreshener } = await import("../src/usage-refresh.ts");
updateAccounts((f) => {
  f.accounts.push({ id: "aaaaaa", label: "a", configDir: A_DIR, order: 0, enabled: true });
  f.accounts.push({ id: "bbbbbb", label: "b", configDir: B_DIR, order: 1, enabled: true });
}, home);

const { port, proxy } = await startMockedProxy("pool-usage-refresh");
const seenDirs: Array<string | undefined> = [];
proxy.setClaudeQueryStarter(async (params: any) => {
  seenDirs.push(params.env.CLAUDE_CONFIG_DIR as string | undefined);
  return mockHandle((async function* () {
    yield textDelta("ok");
    yield { type: "result", is_error: false, usage: {} };
  })());
});

// Fake Anthropic usage endpoint, per account (token = account dir).
const usage: Record<string, number> = {};
let delayMs = 0;
const reads: string[] = [];
const fakeFetch = (async (_u: unknown, init: any) => {
  const dir = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
  reads.push(dir);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  return Response.json({ limits: [{ kind: "session", percent: usage[dir], resets_at: new Date(Date.now() + 3600_000).toISOString() }] });
}) as typeof fetch;
const readCredential = async (dir: string) => ({ accessToken: dir, expiresAt: null, subscriptionType: "pro" });

const send = (session: string) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-claude-session": session, "x-claude-pool-account": "pool" },
    body: JSON.stringify({ model: "sonnet", stream: false, messages: [{ role: "user", content: `hi ${session}` }] }),
  });

try {
  const now = Date.now();
  const stale = now - 10 * 60_000;

  // 1. A running conversation on A, stored at 95% (stale); A is really at 100%: it moves to B.
  setUsageFreshener(makeUsageFreshener({ readCredential, fetch: fakeFetch }, 1000));
  updateState((s) => {
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 95, resetsAt: now + 3600_000, updatedAt: stale });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 20, resetsAt: now + 3600_000, updatedAt: stale });
    bindConversation(s, "s-run", "aaaaaa", now);
  }, home);
  usage[A_DIR] = 100;
  usage[B_DIR] = 20;
  let res = await send("s-run"); assert.equal(res.status, 200); await res.text();
  assert.deepEqual(reads, [A_DIR], "running conversation: only the account near full is re-read");
  assert.equal(seenDirs.at(-1), B_DIR, "the fresh 100% moved the conversation to B");
  assert.equal(readState(home).accounts.aaaaaa.windows.five_hour?.usedPercent, 100);

  // 2. Fresh numbers are not re-read, and the same account is not re-read again within the stale window.
  reads.length = 0;
  res = await send("s-run"); await res.text();
  assert.deepEqual(reads, [], "fresh numbers: no read");

  // 3. A new conversation re-reads every stale account; a slow read does not hold the request.
  setUsageFreshener(makeUsageFreshener({ readCredential, fetch: fakeFetch }, 150));
  updateState((s) => {
    s.accounts.aaaaaa.windows.five_hour = { usedPercent: 10, resetsAt: now + 3600_000, updatedAt: stale };
    s.accounts.bbbbbb.windows.five_hour = { usedPercent: 20, resetsAt: now + 3600_000, updatedAt: stale };
  }, home);
  usage[A_DIR] = 50;
  usage[B_DIR] = 30;
  delayMs = 600;
  reads.length = 0;
  const started = Date.now();
  res = await send("s-new"); assert.equal(res.status, 200); await res.text();
  assert.ok(Date.now() - started < 550, `request waited only the budget (${Date.now() - started} ms)`);
  assert.deepEqual([...reads].sort(), [A_DIR, B_DIR].sort(), "new conversation: every stale account is re-read");
  assert.equal(seenDirs.at(-1), A_DIR, "routed on the old numbers (A 10% < B 20%) while the reads were slow");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(readState(home).accounts.aaaaaa.windows.five_hour?.usedPercent, 50, "the slow read still landed");
  assert.equal(readState(home).accounts.bbbbbb.windows.five_hour?.usedPercent, 30);

  console.log("pool-usage-refresh-regression: ok");
} finally {
  setUsageFreshener(null);
  await proxy.stopProxy();
}
process.exit(0);
