/**
 * Regression: providers follow accounts.json: one pool + one per enabled
 * account; none without accounts. The model.request hook tags pool requests.
 * Run: bun plugin/test/pool-providers-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pool-prov-"));
process.env.CLAUDE_POOL_HOME = home;
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pool-xdg-"));

const { poolProviderSpecs, accountFromProviderId, accountProviderId } = await import("../src/pool.ts");
const { updateAccounts, readAccounts } = await import("../../shared/accounts.ts");

assert.deepEqual(poolProviderSpecs(readAccounts(home)), []);
updateAccounts((f) => {
  f.accounts.push({ id: "aaaaaa", label: "work", configDir: "~/.claude", order: 0, enabled: true });
  f.accounts.push({ id: "bbbbbb", label: "home", configDir: "~/.claude-b", order: 1, enabled: true });
  f.accounts.push({ id: "cccccc", label: "off", configDir: "~/.claude-c", order: 2, enabled: false });
}, home);
assert.deepEqual(poolProviderSpecs(readAccounts(home)), [
  { id: "claude-pool", name: "Claude Pool" },
  { id: "claude-pool-aaaaaa", name: "Claude · work" },
  { id: "claude-pool-bbbbbb", name: "Claude · home" },
]);
assert.equal(accountProviderId("aaaaaa"), "claude-pool-aaaaaa");
assert.equal(accountFromProviderId("claude-pool"), "pool");
assert.equal(accountFromProviderId("claude-pool-bbbbbb"), "bbbbbb");
assert.equal(accountFromProviderId("claude-code"), null);
assert.equal(accountFromProviderId("claude-pool-XYZ"), null);

// setup registers those providers and an unscoped hook that tags requests
const plugin = (await import("../src/index.ts")).default;
const added: Array<{ id: string; modelProviders: string[] }> = [];
let hook: ((r: any) => Promise<void>) | undefined;
let hookOptions: unknown;
const ctx: any = {
  options: {},
  location: { directory: home },
  provider: {
    transform: async (fn: any) => fn({ add: (p: any) => added.push({ id: p.info.id, modelProviders: [...new Set(p.models.map((m: any) => m.providerID))] }) }),
    reload: async () => {},
  },
  session: { hook: async (_n: string, cb: any, opts: unknown) => { hook = cb; hookOptions = opts; return { dispose() {} }; }, switchModel: async () => {} },
  integration: { transform: async () => { throw new Error("pool registers no integration"); } },
  event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
};
const dispose = await plugin.setup(ctx);
assert.deepEqual(added.map((p) => p.id), ["claude-pool", "claude-pool-aaaaaa", "claude-pool-bbbbbb"]);
for (const p of added) assert.deepEqual(p.modelProviders, [p.id], "models carry their own provider id");
assert.equal(hookOptions, undefined, "hook is unscoped");

const req = (providerID: string) => ({ sessionID: "s1", agent: "build", kind: "primary", model: { id: "sonnet", providerID }, headers: {} as Record<string, string> });
const pool = req("claude-pool"); await hook!(pool);
assert.equal(pool.headers["x-claude-pool-account"], "pool");
const fixed = req("claude-pool-bbbbbb"); await hook!(fixed);
assert.equal(fixed.headers["x-claude-pool-account"], "bbbbbb");
const foreign = req("anthropic"); await hook!(foreign);
assert.equal(foreign.headers["x-claude-pool-account"], undefined);
assert.equal((foreign as any).baseURL, undefined, "foreign providers untouched");

await dispose?.();
console.log("ok — pool providers regression passed");
process.exit(0);
