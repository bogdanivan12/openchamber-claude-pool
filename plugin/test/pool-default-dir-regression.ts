/**
 * Regression: in pool mode the default account never inherits the server's
 * CLAUDE_CONFIG_DIR. A request without a config-dir header spawns without the
 * variable (Claude Code then uses ~/.claude and its Keychain item), a request
 * with a header still sets it, and with pool mode off the old env fallback
 * stays.
 * Run: bun plugin/test/pool-default-dir-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const serverDir = mkdtempSync(join(tmpdir(), "pool-server-dir-"));
const accountDir = mkdtempSync(join(tmpdir(), "pool-account-dir-"));
process.env.CLAUDE_CONFIG_DIR = serverDir;

const { claudeConfigDir, setPoolMode, isPoolMode } = await import("../src/config-dir.ts");
const { port, proxy } = await startMockedProxy("pool-default-dir");

let seen: Record<string, any> = {};
proxy.setClaudeQueryStarter(async (params: any) => {
  seen = params;
  return mockHandle((async function* () {
    yield textDelta("ok");
    yield { type: "result", is_error: false, usage: {} };
  })());
});
let n = 0;
const send = async (configDir?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json", "x-opencode-claude-session": `pdd-${n++}` };
  if (configDir) headers["x-opencode-claude-config-dir"] = encodeURIComponent(configDir);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
};

try {
  // Pool mode off: the fork's behaviour is unchanged.
  assert.equal(isPoolMode(), false);
  assert.equal(claudeConfigDir(), serverDir);
  await send();
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, serverDir);

  setPoolMode(true);
  assert.equal(isPoolMode(), true);
  assert.equal(claudeConfigDir(), join(homedir(), ".claude"));
  assert.equal(claudeConfigDir(accountDir), accountDir);
  await send();
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, undefined, "the default account must not inherit CLAUDE_CONFIG_DIR");
  assert.equal("CLAUDE_CONFIG_DIR" in seen.env, false);
  await send(accountDir);
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, accountDir);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, serverDir, "the server's own env is left alone");
  console.log("pool-default-dir-regression: ok");
} finally {
  setPoolMode(false);
  delete process.env.CLAUDE_CONFIG_DIR;
  await proxy.stopProxy();
}
