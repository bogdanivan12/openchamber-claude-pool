/**
 * Regression: the committed bundle loads from a folder with no node_modules
 * (as OpenCode loads an extension's plugin) and registers providers.
 * Run: bun plugin/test/bundle-load-regression.ts
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "claude-pool-bundle-"));
cpSync(join(import.meta.dir, "..", "index.js"), join(dir, "index.js"));
cpSync(join(import.meta.dir, "..", "package.json"), join(dir, "package.json"));
process.env.CLAUDE_POOL_HOME = mkdtempSync(join(tmpdir(), "claude-pool-home-"));

const mod = await import(pathToFileURL(join(dir, "index.js")).href);
const plugin = mod.default;
assert.equal(typeof plugin?.setup, "function", "default export has setup()");

const added: string[] = [];
const noop = async () => ({ dispose() {} });
const ctx: any = {
  options: {},
  location: { directory: dir },
  provider: { transform: async (fn: any) => fn({ add: (p: any) => added.push(p.info.id) }), reload: async () => {} },
  session: { hook: noop, switchModel: async () => {} },
  integration: { transform: async () => {} },
  event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
};
const dispose = await plugin.setup(ctx);
assert.ok(Array.isArray(added));
await dispose?.();
console.log("ok — bundle loads without node_modules");
process.exit(0);
