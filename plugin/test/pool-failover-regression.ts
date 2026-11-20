/**
 * Regression: pool routing. Fixed providers use their account's dir; the pool
 * picks by headroom, sticks to a conversation, reruns a turn on another
 * account when one hits its limit before output, and answers 429 with the
 * earliest reset when every account is limited.
 * Run: bun plugin/test/pool-failover-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "pool-failover-"));
process.env.CLAUDE_POOL_HOME = home;
const A_DIR = join(homedir(), ".claude");
const B_DIR = mkdtempSync(join(tmpdir(), "pool-b-"));
const C_DIR = mkdtempSync(join(tmpdir(), "pool-c-"));

const { updateAccounts } = await import("../../shared/accounts.ts");
const { readState, updateState, recordWindow, markLimited, bindConversation } = await import("../../shared/state.ts");
updateAccounts((f) => {
  f.accounts.push({ id: "aaaaaa", label: "a", configDir: A_DIR, order: 0, enabled: true });
  f.accounts.push({ id: "bbbbbb", label: "b", configDir: B_DIR, order: 1, enabled: true });
  f.accounts.push({ id: "cccccc", label: "c", configDir: C_DIR, order: 2, enabled: true });
}, home);

const { port, proxy } = await startMockedProxy("pool-failover");
const seenDirs: Array<string | undefined> = [];
const limitedDirs = new Set<string | undefined>();
proxy.setClaudeQueryStarter(async (params: any) => {
  const dir = params.env.CLAUDE_CONFIG_DIR as string | undefined;
  seenDirs.push(dir);
  if (limitedDirs.has(dir)) {
    return mockHandle((async function* () {
      yield { type: "result", is_error: true, subtype: "error_during_execution", result: "You've hit your session limit · resets 11pm (UTC)" };
    })());
  }
  return mockHandle((async function* () {
    yield textDelta("ok");
    yield { type: "result", is_error: false, usage: {} };
  })());
});

const send = (account: string, session: string) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-claude-session": session, "x-claude-pool-account": account },
    body: JSON.stringify({ model: "sonnet", stream: false, messages: [{ role: "user", content: `hi ${session}` }] }),
  });

try {
  // 1. fixed provider: default account spawns WITHOUT CLAUDE_CONFIG_DIR
  let res = await send("aaaaaa", "s-fixed-a"); assert.equal(res.status, 200); await res.text();
  assert.equal(seenDirs.at(-1), undefined);
  res = await send("bbbbbb", "s-fixed-b"); assert.equal(res.status, 200); await res.text();
  assert.equal(seenDirs.at(-1), B_DIR);

  // 2. pool picks the most headroom and binds the conversation
  const now = Date.now();
  updateState((s) => {
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 60, resetsAt: now + 3600_000, updatedAt: now });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 10, resetsAt: now + 3600_000, updatedAt: now });
    recordWindow(s, "cccccc", "five_hour", { usedPercent: 30, resetsAt: now + 3600_000, updatedAt: now });
  }, home);
  res = await send("pool", "s-pool"); assert.equal(res.status, 200); await res.text();
  assert.equal(seenDirs.at(-1), B_DIR);
  assert.equal(readState(home).conversations["s-pool"].accountId, "bbbbbb");

  // 3. sticky while available, even if another account now has more room
  updateState((s) => recordWindow(s, "cccccc", "five_hour", { usedPercent: 0, resetsAt: now + 3600_000, updatedAt: now + 1 }), home);
  res = await send("pool", "s-pool"); await res.text();
  assert.equal(seenDirs.at(-1), B_DIR);

  // 4. limit before output: rerun on the next account inside the proxy
  // the real migration hook (installed by startProxy) must carry the transcript
  const { setForeignSessionId, clearForeignSessionId } = await import("../src/session-store.ts");
  const SID = "99999999-0000-0000-0000-000000000000";
  mkdirSync(join(B_DIR, "projects", "p"), { recursive: true });
  writeFileSync(join(B_DIR, "projects", "p", `${SID}.jsonl`), '{"uuid":"leaf"}\n');
  // Start from a clean binding: the boundaries recorded by cases 2-3 would not
  // match this request's history and would drop the session as diverged.
  clearForeignSessionId("s-pool");
  setForeignSessionId("s-pool", SID, { cwd: home });
  limitedDirs.add(B_DIR);
  seenDirs.length = 0;
  // A follow-up turn: the history before the prompt is what the session already holds.
  res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-claude-session": "s-pool", "x-claude-pool-account": "pool" },
    body: JSON.stringify({
      model: "sonnet", stream: false,
      messages: [
        { role: "user", content: "hi s-pool" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "and again" },
      ],
    }),
  });
  assert.equal(res.status, 200, "rerun answered 200");
  await res.text();
  assert.deepEqual(seenDirs, [B_DIR, C_DIR]);
  assert.ok((readState(home).accounts.bbbbbb.limitedUntil ?? 0) > Date.now());
  assert.equal(readState(home).conversations["s-pool"].accountId, "cccccc");
  assert.ok(existsSync(join(C_DIR, "projects", "p", `${SID}.jsonl`)), "transcript followed the conversation");

  // 5. everything limited: 429 with the earliest reset, no endless loop
  limitedDirs.add(C_DIR); limitedDirs.add(undefined);
  seenDirs.length = 0;
  res = await send("pool", "s-all");
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  const body = await res.json();
  assert.equal(body.error.code, "claude_session_limit");
  assert.ok(seenDirs.length <= 3, "at most one try per account");

  // 6. unknown account id is a clear 400
  res = await send("dddddd", "s-x");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Claude Pool account/);

  // 7. no pool header: legacy path untouched
  res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-claude-session": "legacy" },
    body: JSON.stringify({ model: "sonnet", stream: false, messages: [{ role: "user", content: "x" }] }),
  });
  assert.notEqual(res.status, 400); await res.text();

  // 8. G1: a parked bridge keeps its own account even when that account is full
  const { handlePoolChat, setMigrationHook } = await import("../src/pool-proxy.ts");
  const { installTranscriptMigration } = await import("../src/migrate.ts");
  const { putBridge, deleteBridge } = await import("../src/bridge-pool.ts");
  const calls: Array<string | null> = [];
  const fake = async (r: Request) => { calls.push(r.headers.get("x-opencode-claude-config-dir")); return new Response("ok"); };
  const mk = (session: string, kind?: string) => new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "x-claude-pool-account": "pool", "x-opencode-claude-session": session, ...(kind ? { "x-opencode-claude-kind": kind } : {}) },
  });
  const t0 = Date.now();
  updateState((s) => {
    for (const a of Object.values(s.accounts)) a.limitedUntil = null;
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 99, resetsAt: t0 + 3600_000, updatedAt: t0 });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 99, resetsAt: t0 + 3600_000, updatedAt: t0 });
    recordWindow(s, "cccccc", "five_hour", { usedPercent: 1, resetsAt: t0 + 3600_000, updatedAt: t0 });
  }, home);
  const hooks: Array<[string, string, string]> = [];
  setMigrationHook((k, f, t) => hooks.push([k, f, t]));
  putBridge({
    id: "stub-bridge", conversationKey: "s-parked", pendingTools: new Map(), reportedUsage: new Map(),
    forwardedSteering: new Set(), createdAt: Date.now(), configDir: B_DIR,
    handle: { stream: (async function* () {})(), interrupt: async () => {}, close: () => {}, getPid: () => null },
  } as any);
  updateState((s) => bindConversation(s, "s-parked", "bbbbbb", t0), home);
  await handlePoolChat(mk("s-parked"), {}, fake, home);
  assert.deepEqual(calls, [encodeURIComponent(B_DIR)], "parked turn stays on its own account");
  assert.equal(readState(home).conversations["s-parked"].accountId, "bbbbbb", "no rebinding");
  assert.deepEqual(hooks, [], "no migration for a parked continuation");
  deleteBridge("stub-bridge");

  // 9. G2: a title request never rebinds or migrates
  calls.length = 0;
  updateState((s) => bindConversation(s, "s-title", "bbbbbb", t0), home);
  await handlePoolChat(mk("s-title", "title"), {}, fake, home);
  assert.deepEqual(calls, [encodeURIComponent(B_DIR)], "a bound account that is not limited is kept, usage aside");
  updateState((s) => markLimited(s, "bbbbbb", Date.now() + 3600_000), home);
  calls.length = 0;
  await handlePoolChat(mk("s-title", "title"), {}, fake, home);
  assert.deepEqual(calls, [encodeURIComponent(C_DIR)], "a limited bound account routes normally");
  assert.equal(readState(home).conversations["s-title"].accountId, "bbbbbb", "title does not rebind");
  assert.deepEqual(hooks, [], "title does not migrate");
  updateState((s) => bindConversation(s, "s-title2", "cccccc", t0), home);
  calls.length = 0;
  await handlePoolChat(mk("s-title2", "title"), {}, fake, home);
  assert.deepEqual(calls, [encodeURIComponent(C_DIR)], "usable bound account is kept");

  // 10. the migration hook runs on a primary request that moves accounts
  calls.length = 0;
  await handlePoolChat(mk("s-title"), {}, fake, home);
  assert.deepEqual(hooks, [["s-title", B_DIR, C_DIR]]);
  assert.equal(readState(home).conversations["s-title"].accountId, "cccccc");
  setMigrationHook(null);
  installTranscriptMigration(); // restore the real hook for any later case

  // 11. retryAt covers the accounts that were just tried
  const { setNeedsLogin } = await import("../../shared/state.ts");
  const fresh = (ids: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "pool-fresh-"));
    const dirs: Record<string, string> = {};
    updateAccounts((f) => {
      ids.forEach((id, i) => {
        dirs[id] = join(dir, id);
        f.accounts.push({ id, label: id, configDir: dirs[id], order: i, enabled: true });
      });
    }, dir);
    return { dir, dirs };
  };
  const limit429 = (resetsAt: number) =>
    Response.json({ error: { code: "claude_session_limit", resets_at: new Date(resetsAt).toISOString(), retry_after: 1 } }, { status: 429 });
  const byDir = (map: Record<string, number>, hits: string[]) => async (r: Request) => {
    const d = decodeURIComponent(r.headers.get("x-opencode-claude-config-dir") ?? "");
    hits.push(d);
    return map[d] !== undefined ? limit429(map[d]) : new Response("ok");
  };
  const near = (res: Response, seconds: number, slack = 5) =>
    Math.abs(Number(res.headers.get("retry-after")) - seconds) <= slack;

  {
    // (a) A limited and tried, B signed out: earliest is A's reset, not the 600 s fallback
    const { dir, dirs } = fresh(["a1a1a1", "b2b2b2"]);
    updateState((st) => setNeedsLogin(st, "b2b2b2", true), dir);
    const r = await handlePoolChat(mk("s-a"), {}, byDir({ [dirs.a1a1a1]: Date.now() + 3600_000 }, []), dir);
    assert.equal(r.status, 429);
    assert.ok(near(r, 3600), `retry-after ${r.headers.get("retry-after")} should be about 3600`);
  }
  {
    // (b) A +1h and B +5h tried, C limited +3h already: earliest is A
    const { dir, dirs } = fresh(["a1a1a1", "b2b2b2", "c3c3c3"]);
    updateState((st) => markLimited(st, "c3c3c3", Date.now() + 3 * 3600_000), dir);
    const r = await handlePoolChat(
      mk("s-b"), {},
      byDir({ [dirs.a1a1a1]: Date.now() + 3600_000, [dirs.b2b2b2]: Date.now() + 5 * 3600_000 }, []),
      dir,
    );
    assert.equal(r.status, 429);
    assert.ok(near(r, 3600), `retry-after ${r.headers.get("retry-after")} should be about 3600`);
  }
  {
    // (c) stale 429s everywhere: floored, bounded tries, short Retry-After, never the 600 s message
    const { dir, dirs } = fresh(["a1a1a1", "b2b2b2"]);
    const hits: string[] = [];
    const stale = Date.now() - 3600_000;
    const r = await handlePoolChat(mk("s-c"), {}, byDir({ [dirs.a1a1a1]: stale, [dirs.b2b2b2]: stale }, hits), dir);
    assert.equal(r.status, 429);
    assert.equal(hits.length, 2, "one try per account");
    const ra = Number(r.headers.get("retry-after"));
    assert.ok(ra >= 4 && ra <= 5, `retry-after ${ra}`);
    assert.equal((await r.json()).error.code, "claude_session_limit");
    assert.ok((readState(dir).accounts.a1a1a1.limitedUntil ?? 0) > Date.now(), "stale limit still marks the account briefly");
  }
  {
    // (e) the binding is renewed once it is a day old, not before
    const { dir } = fresh(["a1a1a1", "b2b2b2"]);
    updateState((st) => {
      bindConversation(st, "s-old", "a1a1a1", Date.now() - 25 * 3600_000);
      bindConversation(st, "s-new", "a1a1a1", Date.now() - 3600_000);
    }, dir);
    const newAt = readState(dir).conversations["s-new"].at;
    await handlePoolChat(mk("s-old"), {}, async () => new Response("ok"), dir);
    await handlePoolChat(mk("s-new"), {}, async () => new Response("ok"), dir);
    assert.ok(Date.now() - readState(dir).conversations["s-old"].at < 5000, "25 h old binding refreshed");
    assert.equal(readState(dir).conversations["s-new"].at, newAt, "1 h old binding untouched");
  }
  {
    // (d) an unchanged binding is not rewritten
    const { dir } = fresh(["a1a1a1", "b2b2b2"]);
    await handlePoolChat(mk("s-d"), {}, async () => new Response("ok"), dir);
    const first = readState(dir).conversations["s-d"].at;
    await new Promise((r) => setTimeout(r, 25));
    await handlePoolChat(mk("s-d"), {}, async () => new Response("ok"), dir);
    assert.equal(readState(dir).conversations["s-d"].at, first);
  }
} finally {
  proxy.setClaudeQueryStarter(null);
  await proxy.stopProxy();
}
console.log("ok — pool failover regression passed");
process.exit(0);
