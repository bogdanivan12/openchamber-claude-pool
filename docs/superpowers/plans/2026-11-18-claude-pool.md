# Claude Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OpenChamber extension that serves Claude subscription models from any number of Claude accounts (a failover pool plus one provider per account), on macOS and Windows, with a usage card covering every account.

**Architecture:** One extension package. (1) `plugin/` is the user's fork of `opencode-claude`, imported with its history. It registers `claude-pool` and `claude-pool-<id>` providers, and its local proxy picks the account (`CLAUDE_CONFIG_DIR`) per request and reruns a turn on another account after a limit. (2) `service/` is an on-demand Node service. It answers OpenChamber's quota calls and the panel's account API, which includes the in-app `claude auth login`. (3) `ui/` holds the rail panel and the Work Status section. `shared/` contains pure modules used by both sides. The plugin and the service talk only through `~/.claude-pool/accounts.json` and `state.json`.

**Tech Stack:** TypeScript, Bun 1.4 (tests, bundling), Node runtime inside OpenChamber/OpenCode, `@anthropic-ai/claude-agent-sdk`, `@openchamber/sdk@2.7.2` (manifest, quota wire, UI kit, `openchamber-guest-bundle`, `openchamber-guest-check`), `zod@4`.

**Spec:** `docs/superpowers/specs/2026-11-18-claude-pool-design.md`

## Global Constraints

- Platforms: macOS and Windows. Never hard-code `/`; build paths with `path.join`/`path.resolve` and `os.homedir()`.
- No daemon, LaunchAgent or polling loop. The service runs only on demand (`keepRunning` is NOT set). The plugin may use `fs.watch` (event-driven).
- Provider ids: `claude-pool` (pool) and `claude-pool-<id>` (`id` = 6 lowercase hex chars). Never `claude-code`.
- Data dir: `~/.claude-pool/` (env override `CLAUDE_POOL_HOME` for tests). New account dirs: `~/.claude-pool/accounts/<id>`.
- The default account dir `~/.claude` is spawned WITHOUT `CLAUDE_CONFIG_DIR` (setting it would change the Keychain item name).
- macOS Keychain service: `Claude Code-credentials` for `~/.claude`, else `Claude Code-credentials-<first 8 hex of sha256(absolute dir, no trailing separator)>`. Pinned: `/Users/bogdanivan/.claude-b` → `fae08b37`.
- The extension never writes or refreshes OAuth tokens and never logs a token.
- Usage numbers are `usedPercent` 0..100 everywhere. Window names in state: `five_hour`, `seven_day`. Card window keys: `5h`, `7d`.
- Default threshold 90, allowed 50..100.
- Conversation bindings are pruned after 30 days. Lock files are stale after 10 s.
- Every write to `accounts.json` / `state.json` is atomic (temp + rename) under `~/.claude-pool/state.lock`.
- OpenChamber engine floor: `>=2.7.0`. `panel.id` is `claude-pool` (≤ 28 chars), so the quota provider id is `ext-claude-pool`.
- Built `.js` bundles (`plugin/index.js`, `service/main.js`, `ui/panel/main.js`, `ui/status/main.js`) are committed. Installation never builds and never installs dependencies.
- Code, comments, commits and docs in English.
- License: MIT, keeping the original `opencode-claude` copyright line.

## File Map

```
package.json                     root: manifest (`openchamber` key), deps, scripts
tsconfig.json
bunfig.toml                      test root config
scripts/build.ts                 bundles plugin/service/ui
scripts/check-bundles.ts         fails if a committed bundle is stale
shared/paths.ts                  data dir, account dirs, keychain service name
shared/store-io.ts               readJsonFile, writeJsonAtomic, withLock
shared/accounts.ts               accounts.json model + mutations
shared/state.ts                  state.json model + mutations
shared/router.ts                 pure account choice
shared/creds.ts                  read-only per-OS credential read
shared/*.test.ts                 bun tests
plugin/                          fork of opencode-claude (history kept)
  package.json                   minimal, type module (OpenCode loads plugin/index.js)
  index.js                       BUILT bundle (committed)
  src/pool.ts                    provider ids/specs, header names
  src/pool-proxy.ts              account resolution + failover wrapper
  src/pool-state-bridge.ts       rate-limit events -> state.json
  src/migrate.ts                 transcript copy between config dirs
  src/index.ts                   (modified) multi-provider registration
  src/proxy.ts                   (modified) one call site
  src/rate-limit.ts              (modified) listener hook
  test/pool-*.ts                 new regression files (run by plugin/test/run.ts)
service/
  src/main.ts                    http server, routing
  src/usage.ts                   /api/oauth/usage per account
  src/quota.ts                   quota answer builder
  src/accounts-api.ts            account endpoints
  src/auth-status.ts             `claude auth status --json` per dir
  src/login.ts                   in-app login relay per dir
  src/import.ts                  import candidates
  src/*.test.ts
  main.js                        BUILT bundle (committed)
ui/
  shared/api.ts                  typed serviceRequest wrappers
  shared/format.ts               pure formatting (tested)
  panel/index.html, panel/main.ts, panel/main.js (built)
  status/index.html, status/main.ts, status/main.js (built)
.github/workflows/ci.yml
README.md, CHANGELOG.md, LICENSE, docs/e2e-checklist.md
```

---

### Task 1: Bootstrap the repo and import the fork

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `LICENSE`
- Create (via subtree): `plugin/**`
- Modify: `plugin/package.json`, `plugin/test/run.ts` (none if paths still work)
- Delete: `plugin/opencode-claude.js`, `plugin/server.js`, `plugin/bun.lock`, `plugin/tsconfig.json`

**Interfaces:**
- Produces: root scripts `bun run test:shared`, `bun run test:plugin`, `bun run check`, `bun run build`. The plugin sources stay at `plugin/src/*.ts`; tests at `plugin/test/*.ts`.

- [ ] **Step 1: Import the fork with history**

```bash
cd ~/Documents/Projects/openchamber-claude-pool
git subtree add --prefix=plugin ~/Documents/Projects/opencode-claude main
git rm -q plugin/opencode-claude.js plugin/server.js plugin/bun.lock plugin/tsconfig.json
```

- [ ] **Step 2: Write `plugin/package.json`** (replaces the npm package manifest; deps move to the root)

```json
{
  "name": "claude-pool-opencode-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "OpenCode plugin bundled by the Claude Pool OpenChamber extension. OpenCode loads index.js."
}
```

- [ ] **Step 3: Write root `package.json`**

```json
{
  "name": "openchamber-claude-pool",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "description": "Any number of Claude subscriptions in OpenChamber: a failover pool, one provider per account, and a usage card for all of them.",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=2.7.0" },
    "contributes": {
      "panel": { "id": "claude-pool", "name": "Claude Pool", "icon": "stack-line", "entry": "ui/panel/index.html" },
      "statusSection": { "entry": "ui/status/index.html", "title": "Claude Pool", "height": 96 },
      "service": {
        "entry": "service/main.js",
        "runtime": "host",
        "provides": ["quota"],
        "permissions": { "exec": ["claude", "security"] }
      },
      "quota": { "providers": [] },
      "opencodePlugin": "plugin"
    }
  },
  "scripts": {
    "test:shared": "bun test shared service ui",
    "test:plugin": "bun plugin/test/run.ts",
    "test": "bun run test:shared && bun run test:plugin",
    "check": "tsc -p tsconfig.json --noEmit",
    "build": "bun scripts/build.ts",
    "check:bundles": "bun scripts/check-bundles.ts",
    "check:guest": "openchamber-guest-check ."
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.224",
    "@openchamber/sdk": "2.7.2",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@opencode/plugin": "2.0.16",
    "@types/bun": "^1.3.11",
    "@types/node": "^22.15.0",
    "typescript": "^5.9.3"
  },
  "packageManager": "bun@1.4.4"
}
```

- [ ] **Step 4: Write `tsconfig.json`, `bunfig.toml`, `.gitignore`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "types": ["bun", "node"]
  },
  "include": ["shared", "plugin/src", "service/src", "ui", "scripts"]
}
```

```toml
# bunfig.toml
[test]
root = "."
```

```
# .gitignore
node_modules/
*.tmp
.DS_Store
```

- [ ] **Step 5: LICENSE.** Copy `plugin/LICENSE` to the root, and add a second copyright line above the original one: `Copyright (c) 2026 Bogdan Ivan (Claude Pool)`. Keep the original line unchanged.

- [ ] **Step 6: Install and run the fork's suite from the new location**

Run: `bun install && bun run test:plugin`
Expected: every `pass …` line. `plugin/test/run.ts` resolves files from `import.meta.dir`, so it works unchanged. If a test imports `../opencode-claude.js` or `../server.js`, change that import to `../src/index.ts`.

- [ ] **Step 7: Type-check**

Run: `bun run check`
Expected: no errors. (`shared/`, `service/` and `ui/` don't exist yet; tsc ignores missing include roots.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: import opencode-claude fork as plugin/ and set up the extension package"
```

---

### Task 2: Plugin bundle feasibility gate

The plugin must load from `plugin/index.js` with a bare `import()` and no `node_modules`. This gate proves that a bundle containing the Agent SDK loads and registers its provider. **If Step 4 fails, stop and report: the packaging approach needs a decision from the user.**

**Files:**
- Create: `scripts/build.ts`
- Create: `plugin/test/bundle-load-regression.ts`
- Create (built): `plugin/index.js`

**Interfaces:**
- Produces: `bun scripts/build.ts [plugin|service|ui|all]`, which writes the committed bundles.

- [ ] **Step 1: Write the load test** (`plugin/test/bundle-load-regression.ts`)

```ts
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
```

- [ ] **Step 2: Write `scripts/build.ts`**

```ts
/** Bundles every entry that installation loads. Usage: bun scripts/build.ts [plugin|service|ui|all] */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const target = process.argv[2] ?? "all";

async function bundle(entry: string, outfile: string, platform: "node" | "browser") {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target: platform === "node" ? "node" : "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bundle failed: ${entry}`);
  }
  await Bun.write(join(root, outfile), await result.outputs[0].text());
  console.log(`built ${outfile}`);
}

if (target === "plugin" || target === "all") await bundle("plugin/src/index.ts", "plugin/index.js", "node");
if (target === "service" || target === "all") await bundle("service/src/main.ts", "service/main.js", "node");
if (target === "ui" || target === "all") {
  await bundle("ui/panel/main.ts", "ui/panel/main.js", "browser");
  await bundle("ui/status/main.ts", "ui/status/main.js", "browser");
}
```

(`minify: false` keeps bundles stable across Bun versions, which `check-bundles` relies on.)

- [ ] **Step 3: Build the plugin**

Run: `bun scripts/build.ts plugin`
Expected: `built plugin/index.js`

- [ ] **Step 4: Run the gate**

Run: `bun plugin/test/bundle-load-regression.ts && node plugin/test/bundle-load-regression.ts 2>/dev/null || bun plugin/test/bundle-load-regression.ts`
Expected: `ok — bundle loads without node_modules`. If the import throws (for example the Agent SDK resolving a file relative to `import.meta.url`), record the exact error and stop here.

- [ ] **Step 5: Check that the SDK does not need its own CLI copy.** The fork already passes `pathToClaudeCodeExecutable` from `resolveClaudeCodeExecutable()` (see `plugin/src/query.ts`). Confirm:

Run: `grep -n "pathToClaudeCodeExecutable" plugin/src/query.ts`
Expected: at least one match. If there is none, stop and report.

- [ ] **Step 6: Commit**

```bash
git add scripts/build.ts plugin/index.js plugin/test/bundle-load-regression.ts
git commit -m "build: self-contained plugin bundle and a load gate"
```

---

### Task 3: `shared/paths.ts`

**Files:**
- Create: `shared/paths.ts`, `shared/paths.test.ts`

**Interfaces:**
- Produces:
  - `poolDataDir(home?: string): string`
  - `accountsFile(dataDir?: string): string`, `stateFile(dataDir?: string): string`, `lockFile(dataDir?: string): string`
  - `defaultConfigDir(home?: string): string`
  - `newAccountDir(id: string, dataDir?: string): string`
  - `normalizeDir(p: string, home?: string): string`
  - `isDefaultConfigDir(dir: string, home?: string): boolean`
  - `keychainService(configDir: string, home?: string): string`
  - `isInsidePoolAccounts(dir: string, dataDir?: string): boolean`

- [ ] **Step 1: Write the failing test** (`shared/paths.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  accountsFile, defaultConfigDir, isDefaultConfigDir, isInsidePoolAccounts,
  keychainService, newAccountDir, normalizeDir, poolDataDir, stateFile,
} from "./paths.ts";

const HOME = process.platform === "win32" ? "C:\\Users\\u" : "/Users/u";

describe("paths", () => {
  it("data dir defaults under home and honours CLAUDE_POOL_HOME", () => {
    const saved = process.env.CLAUDE_POOL_HOME;
    delete process.env.CLAUDE_POOL_HOME;
    expect(poolDataDir(HOME)).toBe(join(HOME, ".claude-pool"));
    process.env.CLAUDE_POOL_HOME = join(HOME, "x");
    expect(poolDataDir(HOME)).toBe(join(HOME, "x"));
    if (saved === undefined) delete process.env.CLAUDE_POOL_HOME; else process.env.CLAUDE_POOL_HOME = saved;
  });

  it("files live in the data dir", () => {
    const d = join(HOME, ".claude-pool");
    expect(accountsFile(d)).toBe(join(d, "accounts.json"));
    expect(stateFile(d)).toBe(join(d, "state.json"));
    expect(newAccountDir("abc123", d)).toBe(join(d, "accounts", "abc123"));
  });

  it("normalizes ~ and trailing separators", () => {
    expect(normalizeDir("~/.claude-b/", HOME)).toBe(join(HOME, ".claude-b"));
    expect(normalizeDir(join(HOME, ".claude"), HOME)).toBe(join(HOME, ".claude"));
  });

  it("recognises the default dir", () => {
    expect(isDefaultConfigDir("~/.claude", HOME)).toBe(true);
    expect(isDefaultConfigDir("~/.claude-b", HOME)).toBe(false);
    expect(defaultConfigDir(HOME)).toBe(join(HOME, ".claude"));
  });

  it("keychain service: default has no suffix, others hash the absolute dir", () => {
    expect(keychainService("~/.claude", HOME)).toBe("Claude Code-credentials");
    if (process.platform !== "win32") {
      // Verified against a real login on 2026-11-18.
      expect(keychainService("/Users/bogdanivan/.claude-b", "/Users/bogdanivan")).toBe("Claude Code-credentials-fae08b37");
      expect(keychainService("/Users/bogdanivan/.claude-b/", "/Users/bogdanivan")).toBe("Claude Code-credentials-fae08b37");
    }
  });

  it("knows which dirs the pool created", () => {
    const d = join(HOME, ".claude-pool");
    expect(isInsidePoolAccounts(join(d, "accounts", "abc123"), d)).toBe(true);
    expect(isInsidePoolAccounts(join(HOME, ".claude-b"), d)).toBe(false);
    expect(isInsidePoolAccounts(join(d, "accounts"), d)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/paths.test.ts`
Expected: FAIL, `Cannot find module './paths.ts'`

- [ ] **Step 3: Implement** (`shared/paths.ts`)

```ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep, isAbsolute } from "node:path";

export function poolDataDir(home: string = homedir()): string {
  const override = process.env.CLAUDE_POOL_HOME?.trim();
  return override ? resolve(override) : join(home, ".claude-pool");
}

export const accountsFile = (dataDir: string = poolDataDir()): string => join(dataDir, "accounts.json");
export const stateFile = (dataDir: string = poolDataDir()): string => join(dataDir, "state.json");
export const lockFile = (dataDir: string = poolDataDir()): string => join(dataDir, "state.lock");
export const defaultConfigDir = (home: string = homedir()): string => join(home, ".claude");
export const newAccountDir = (id: string, dataDir: string = poolDataDir()): string => join(dataDir, "accounts", id);

/** Absolute, `~` expanded, no trailing separator (except a filesystem root). */
export function normalizeDir(p: string, home: string = homedir()): string {
  let value = p.trim();
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(home, value.slice(2));
  let out = resolve(value);
  const root = parse(out).root;
  while (out.length > root.length && (out.endsWith(sep) || out.endsWith("/"))) out = out.slice(0, -1);
  return out;
}

export const isDefaultConfigDir = (dir: string, home: string = homedir()): boolean =>
  normalizeDir(dir, home) === defaultConfigDir(home);

/** Claude Code keys a non-default config dir's Keychain item by sha256 of the exact dir string. */
export function keychainService(configDir: string, home: string = homedir()): string {
  if (isDefaultConfigDir(configDir, home)) return "Claude Code-credentials";
  const hash = createHash("sha256").update(normalizeDir(configDir, home)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** True only for `<dataDir>/accounts/<one segment>`: dirs the pool created and may delete. */
export function isInsidePoolAccounts(dir: string, dataDir: string = poolDataDir()): boolean {
  const rel = relative(join(dataDir, "accounts"), normalizeDir(dir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/paths.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/paths.ts shared/paths.test.ts
git commit -m "feat(shared): pool paths and keychain service names"
```

---

### Task 4: `shared/store-io.ts`

**Files:**
- Create: `shared/store-io.ts`, `shared/store-io.test.ts`

**Interfaces:**
- Produces:
  - `readJsonFile(path: string): unknown | undefined` (`undefined` when missing; throws `SyntaxError` when invalid)
  - `writeJsonAtomic(path: string, value: unknown): void`
  - `withLock<T>(lockPath: string, fn: () => T, opts?: { staleMs?: number; timeoutMs?: number }): T`
  - `sleepSync(ms: number): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, withLock, writeJsonAtomic } from "./store-io.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pool-io-"));

describe("store-io", () => {
  it("round-trips JSON atomically and creates folders", () => {
    const file = join(tmp(), "a", "b.json");
    writeJsonAtomic(file, { x: 1 });
    expect(readJsonFile(file)).toEqual({ x: 1 });
    writeJsonAtomic(file, { x: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ x: 2 });
  });

  it("missing file is undefined, invalid file throws", () => {
    const dir = tmp();
    expect(readJsonFile(join(dir, "none.json"))).toBeUndefined();
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(() => readJsonFile(join(dir, "bad.json"))).toThrow(SyntaxError);
  });

  it("lock runs fn, removes the lock, and returns its value", () => {
    const lock = join(tmp(), "state.lock");
    expect(withLock(lock, () => 42)).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it("lock is released when fn throws", () => {
    const lock = join(tmp(), "state.lock");
    expect(() => withLock(lock, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  it("a stale lock is taken over", () => {
    const lock = join(tmp(), "state.lock");
    writeFileSync(lock, "old");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    expect(withLock(lock, () => "ok", { staleMs: 10_000, timeoutMs: 500 })).toBe("ok");
  });

  it("a fresh foreign lock times out", () => {
    const lock = join(tmp(), "state.lock");
    writeFileSync(lock, "held");
    expect(() => withLock(lock, () => 1, { staleMs: 10_000, timeoutMs: 100 })).toThrow(/lock/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/store-io.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const sab = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sab, 0, 0, ms);
}

export function readJsonFile(path: string): unknown | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** temp + rename; retried on Windows sharing errors (EPERM/EBUSY/EACCES). */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        try { unlinkSync(tmp); } catch {}
        throw err;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

export function withLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): T {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // vanished between checks
      }
      if (Date.now() > deadline) throw new Error(`could not take the Claude Pool lock at ${lockPath}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/store-io.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/store-io.ts shared/store-io.test.ts
git commit -m "feat(shared): atomic JSON writes and a stale-aware file lock"
```

---

### Task 5: `shared/accounts.ts`

**Files:**
- Create: `shared/accounts.ts`, `shared/accounts.test.ts`

**Interfaces:**
- Consumes: `accountsFile`, `lockFile`, `normalizeDir`, `poolDataDir` (Task 3); `readJsonFile`, `writeJsonAtomic`, `withLock` (Task 4)
- Produces:
  - `type Account = { id: string; label: string; configDir: string; order: number; enabled: boolean; email?: string; plan?: string }`
  - `type AccountsFile = { version: 1; accounts: Account[]; threshold: number }`
  - `DEFAULT_THRESHOLD = 90`, `MIN_THRESHOLD = 50`, `MAX_THRESHOLD = 100`
  - `emptyAccounts(): AccountsFile`
  - `readAccounts(dataDir?: string): AccountsFile` (missing → empty; corrupt → renamed to `accounts.json.bak`, returns empty)
  - `updateAccounts(mutate: (file: AccountsFile) => void, dataDir?: string): AccountsFile`
  - `newAccountId(taken: Iterable<string>): string`
  - `enabledAccounts(file: AccountsFile): Account[]` (enabled, sorted by `order`)
  - `findByConfigDir(file: AccountsFile, dir: string | undefined): Account | undefined` (`undefined` dir means the default `~/.claude`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THRESHOLD, emptyAccounts, enabledAccounts, findByConfigDir,
  newAccountId, readAccounts, updateAccounts,
} from "./accounts.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pool-acc-"));

describe("accounts", () => {
  it("missing file reads as empty with the default threshold", () => {
    expect(readAccounts(dir())).toEqual({ version: 1, accounts: [], threshold: DEFAULT_THRESHOLD });
  });

  it("update persists and normalizes config dirs", () => {
    const d = dir();
    updateAccounts((f) => {
      f.accounts.push({ id: "a1b2c3", label: "work", configDir: "~/.claude", order: 0, enabled: true });
    }, d);
    const read = readAccounts(d);
    expect(read.accounts[0].configDir).toBe(join(homedir(), ".claude"));
  });

  it("corrupt file is moved to .bak and reads as empty", () => {
    const d = dir();
    writeFileSync(join(d, "accounts.json"), "{bad");
    expect(readAccounts(d).accounts).toEqual([]);
    expect(existsSync(join(d, "accounts.json.bak"))).toBe(true);
  });

  it("rejects invalid ids, labels and thresholds", () => {
    const d = dir();
    expect(() => updateAccounts((f) => { f.threshold = 20; }, d)).toThrow();
    expect(() => updateAccounts((f) => {
      f.accounts.push({ id: "XYZ", label: "x", configDir: "/x", order: 0, enabled: true });
    }, d)).toThrow();
    expect(() => updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "", configDir: "/x", order: 0, enabled: true });
    }, d)).toThrow();
  });

  it("new ids are 6 hex and unique", () => {
    const id = newAccountId(["aaaaaa"]);
    expect(id).toMatch(/^[0-9a-f]{6}$/);
    expect(id).not.toBe("aaaaaa");
  });

  it("enabled accounts are sorted by order", () => {
    const f = emptyAccounts();
    f.accounts = [
      { id: "bbbbbb", label: "b", configDir: "/b", order: 1, enabled: true },
      { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true },
      { id: "cccccc", label: "c", configDir: "/c", order: 2, enabled: false },
    ];
    expect(enabledAccounts(f).map((a) => a.id)).toEqual(["aaaaaa", "bbbbbb"]);
  });

  it("finds an account by config dir; undefined means the default dir", () => {
    const f = emptyAccounts();
    const def = join(homedir(), ".claude");
    f.accounts = [
      { id: "aaaaaa", label: "a", configDir: def, order: 0, enabled: true },
      { id: "bbbbbb", label: "b", configDir: join(homedir(), ".claude-b"), order: 1, enabled: true },
    ];
    expect(findByConfigDir(f, undefined)?.id).toBe("aaaaaa");
    expect(findByConfigDir(f, join(homedir(), ".claude-b") + "/")?.id).toBe("bbbbbb");
    expect(findByConfigDir(f, "/nowhere")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/accounts.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod";
import { accountsFile, defaultConfigDir, lockFile, normalizeDir, poolDataDir } from "./paths.ts";
import { readJsonFile, withLock, writeJsonAtomic } from "./store-io.ts";

export const DEFAULT_THRESHOLD = 90;
export const MIN_THRESHOLD = 50;
export const MAX_THRESHOLD = 100;

const accountSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{6}$/),
  label: z.string().trim().min(1).max(40),
  configDir: z.string().min(1),
  order: z.number().int().min(0),
  enabled: z.boolean(),
  email: z.string().optional(),
  plan: z.string().optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountSchema),
  threshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
});

export type Account = z.infer<typeof accountSchema>;
export type AccountsFile = z.infer<typeof fileSchema>;

export const emptyAccounts = (): AccountsFile => ({ version: 1, accounts: [], threshold: DEFAULT_THRESHOLD });

function parse(raw: unknown): AccountsFile {
  const file = fileSchema.parse(raw);
  const ids = new Set(file.accounts.map((a) => a.id));
  if (ids.size !== file.accounts.length) throw new Error("duplicate account id");
  return file;
}

export function readAccounts(dataDir: string = poolDataDir()): AccountsFile {
  const path = accountsFile(dataDir);
  try {
    const raw = readJsonFile(path);
    return raw === undefined ? emptyAccounts() : parse(raw);
  } catch (err) {
    try { renameSync(path, `${path}.bak`); } catch {}
    console.warn("[claude-pool] accounts.json was unreadable and was moved to accounts.json.bak:", (err as Error).message);
    return emptyAccounts();
  }
}

export function updateAccounts(mutate: (file: AccountsFile) => void, dataDir: string = poolDataDir()): AccountsFile {
  return withLock(lockFile(dataDir), () => {
    const file = readAccounts(dataDir);
    mutate(file);
    for (const a of file.accounts) a.configDir = normalizeDir(a.configDir);
    const valid = parse(file);
    writeJsonAtomic(accountsFile(dataDir), valid);
    return valid;
  });
}

export function newAccountId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = randomBytes(3).toString("hex");
    if (!used.has(id)) return id;
  }
}

export const enabledAccounts = (file: AccountsFile): Account[] =>
  file.accounts.filter((a) => a.enabled).sort((a, b) => a.order - b.order);

export function findByConfigDir(file: AccountsFile, dir: string | undefined): Account | undefined {
  const wanted = normalizeDir(dir ?? defaultConfigDir());
  return file.accounts.find((a) => normalizeDir(a.configDir) === wanted);
}
```

Note: `withLock` uses `state.lock` for both files. This is deliberate: one lock for all pool writes.

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/accounts.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/accounts.ts shared/accounts.test.ts
git commit -m "feat(shared): accounts.json model with validation and recovery"
```

---

### Task 6: `shared/state.ts`

**Files:**
- Create: `shared/state.ts`, `shared/state.test.ts`
- Modify: `docs/superpowers/specs/2026-11-18-claude-pool-design.md`. In the `state.json` example, change `"conversations": { "<conversationKey>": "a1b2c3" }` to `"conversations": { "<conversationKey>": { "accountId": "a1b2c3", "at": 1763480000000 } }`, and drop the per-account `updatedAt`/`source` keys (each window carries its own `updatedAt`).

**Interfaces:**
- Consumes: Task 3, Task 4
- Produces:
  - `type WindowName = "five_hour" | "seven_day"`
  - `type WindowState = { usedPercent: number; resetsAt: number | null; updatedAt: number }`
  - `type AccountState = { windows: Partial<Record<WindowName, WindowState>>; limitedUntil: number | null; needsLogin: boolean }`
  - `type PoolState = { version: 1; accounts: Record<string, AccountState>; conversations: Record<string, { accountId: string; at: number }> }`
  - `emptyState(): PoolState`
  - `readState(dataDir?: string): PoolState` (missing or corrupt → empty)
  - `updateState(mutate: (s: PoolState) => void, dataDir?: string, now?: number): PoolState` (prunes conversations older than 30 days)
  - `accountState(s: PoolState, id: string): AccountState` (creates on demand)
  - `recordWindow(s: PoolState, id: string, name: WindowName, w: WindowState): void` (keeps the newer `updatedAt`)
  - `markLimited(s: PoolState, id: string, until: number): void` (keeps the later deadline)
  - `setNeedsLogin(s: PoolState, id: string, value: boolean): void`
  - `bindConversation(s: PoolState, key: string, id: string, now: number): void`
  - `windowNameFromRateLimitType(t: string | undefined): WindowName | undefined`
  - `toPercent(value: number): number` (≤ 1 → ×100, clamped 0..100)
  - `CONVERSATION_TTL_MS = 30 * 24 * 3600 * 1000`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_TTL_MS, bindConversation, emptyState, markLimited, readState, recordWindow,
  setNeedsLogin, toPercent, updateState, windowNameFromRateLimitType,
} from "./state.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pool-state-"));

describe("state", () => {
  it("missing and corrupt files read as empty", () => {
    const d = dir();
    expect(readState(d)).toEqual(emptyState());
    writeFileSync(join(d, "state.json"), "{x");
    expect(readState(d)).toEqual(emptyState());
  });

  it("newer window sample wins, older one is ignored", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 40, resetsAt: 1000, updatedAt: 10 });
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 10, resetsAt: 1000, updatedAt: 5 });
    expect(s.accounts.aaaaaa.windows.five_hour?.usedPercent).toBe(40);
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 55, resetsAt: 1000, updatedAt: 11 });
    expect(s.accounts.aaaaaa.windows.five_hour?.usedPercent).toBe(55);
  });

  it("limits keep the later deadline; needsLogin toggles", () => {
    const s = emptyState();
    markLimited(s, "aaaaaa", 2000);
    markLimited(s, "aaaaaa", 1000);
    expect(s.accounts.aaaaaa.limitedUntil).toBe(2000);
    setNeedsLogin(s, "aaaaaa", true);
    expect(s.accounts.aaaaaa.needsLogin).toBe(true);
  });

  it("update persists and prunes old conversations", () => {
    const d = dir();
    const now = 10 * CONVERSATION_TTL_MS;
    updateState((s) => {
      bindConversation(s, "old", "aaaaaa", now - CONVERSATION_TTL_MS - 1);
      bindConversation(s, "new", "aaaaaa", now);
    }, d, now);
    expect(Object.keys(readState(d).conversations)).toEqual(["new"]);
  });

  it("maps SDK rate limit types and fractions", () => {
    expect(windowNameFromRateLimitType("five_hour")).toBe("five_hour");
    expect(windowNameFromRateLimitType("seven_day")).toBe("seven_day");
    expect(windowNameFromRateLimitType("seven_day_opus")).toBeUndefined();
    expect(toPercent(0.42)).toBe(42);
    expect(toPercent(73)).toBe(73);
    expect(toPercent(140)).toBe(100);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/state.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";
import { lockFile, poolDataDir, stateFile } from "./paths.ts";
import { readJsonFile, withLock, writeJsonAtomic } from "./store-io.ts";

export const CONVERSATION_TTL_MS = 30 * 24 * 3600 * 1000;

const windowSchema = z.object({ usedPercent: z.number().min(0).max(100), resetsAt: z.number().nullable(), updatedAt: z.number() });
const accountSchema = z.object({
  windows: z.object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() }),
  limitedUntil: z.number().nullable(),
  needsLogin: z.boolean(),
});
const stateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), accountSchema),
  conversations: z.record(z.string(), z.object({ accountId: z.string(), at: z.number() })),
});

export type WindowName = "five_hour" | "seven_day";
export type WindowState = z.infer<typeof windowSchema>;
export type AccountState = z.infer<typeof accountSchema>;
export type PoolState = z.infer<typeof stateSchema>;

export const emptyState = (): PoolState => ({ version: 1, accounts: {}, conversations: {} });

export function readState(dataDir: string = poolDataDir()): PoolState {
  try {
    const raw = readJsonFile(stateFile(dataDir));
    return raw === undefined ? emptyState() : stateSchema.parse(raw);
  } catch {
    return emptyState(); // rebuilt from the next events and usage reads
  }
}

export function updateState(mutate: (s: PoolState) => void, dataDir: string = poolDataDir(), now: number = Date.now()): PoolState {
  return withLock(lockFile(dataDir), () => {
    const s = readState(dataDir);
    mutate(s);
    for (const [key, b] of Object.entries(s.conversations)) {
      if (now - b.at > CONVERSATION_TTL_MS) delete s.conversations[key];
    }
    writeJsonAtomic(stateFile(dataDir), s);
    return s;
  });
}

export function accountState(s: PoolState, id: string): AccountState {
  return (s.accounts[id] ??= { windows: {}, limitedUntil: null, needsLogin: false });
}

export function recordWindow(s: PoolState, id: string, name: WindowName, w: WindowState): void {
  const a = accountState(s, id);
  const prev = a.windows[name];
  if (!prev || w.updatedAt >= prev.updatedAt) a.windows[name] = w;
}

export function markLimited(s: PoolState, id: string, until: number): void {
  const a = accountState(s, id);
  a.limitedUntil = Math.max(a.limitedUntil ?? 0, until);
}

export function setNeedsLogin(s: PoolState, id: string, value: boolean): void {
  accountState(s, id).needsLogin = value;
}

export function bindConversation(s: PoolState, key: string, id: string, now: number): void {
  s.conversations[key] = { accountId: id, at: now };
}

export function windowNameFromRateLimitType(t: string | undefined): WindowName | undefined {
  return t === "five_hour" || t === "seven_day" ? t : undefined;
}

export function toPercent(value: number): number {
  const pct = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/state.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Update the spec example as listed under Files, then commit**

```bash
git add shared/state.ts shared/state.test.ts docs/superpowers/specs/2026-11-18-claude-pool-design.md
git commit -m "feat(shared): state.json model with merge, limits and binding pruning"
```

---

### Task 7: `shared/router.ts`

**Files:**
- Create: `shared/router.ts`, `shared/router.test.ts`

**Interfaces:**
- Consumes: `Account` (Task 5); `PoolState`, `AccountState` (Task 6)
- Produces:
  - `type RouteInput = { accounts: Account[]; state: PoolState; threshold: number; now: number; current?: string; exclude?: ReadonlySet<string> }`
  - `type RouteResult = { kind: "account"; account: Account } | { kind: "none"; retryAt: number | null }`
  - `isAvailable(account: Account, st: AccountState | undefined, threshold: number, now: number): boolean`
  - `headroom(st: AccountState | undefined, threshold: number, now: number): number`
  - `nextAvailableAt(account: Account, st: AccountState | undefined, threshold: number, now: number): number | null`
  - `route(input: RouteInput): RouteResult`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import type { Account } from "./accounts.ts";
import { emptyState, markLimited, recordWindow, setNeedsLogin } from "./state.ts";
import { headroom, isAvailable, nextAvailableAt, route } from "./router.ts";

const acc = (id: string, order: number, enabled = true): Account => ({ id, label: id, configDir: `/${id}`, order, enabled });
const A = acc("aaaaaa", 0), B = acc("bbbbbb", 1), C = acc("cccccc", 2);
const NOW = 1_000_000;
const win = (pct: number, resetsAt: number | null = NOW + 3600_000) => ({ usedPercent: pct, resetsAt, updatedAt: NOW });

describe("router", () => {
  it("availability honours enabled, needsLogin, limitedUntil and threshold per window", () => {
    const s = emptyState();
    expect(isAvailable(A, s.accounts.aaaaaa, 90, NOW)).toBe(true);
    expect(isAvailable(acc("dddddd", 3, false), undefined, 90, NOW)).toBe(false);
    setNeedsLogin(s, "aaaaaa", true);
    expect(isAvailable(A, s.accounts.aaaaaa, 90, NOW)).toBe(false);
    setNeedsLogin(s, "aaaaaa", false);
    markLimited(s, "aaaaaa", NOW + 10);
    expect(isAvailable(A, s.accounts.aaaaaa, 90, NOW)).toBe(false);
    expect(isAvailable(A, s.accounts.aaaaaa, 90, NOW + 11)).toBe(true);
    recordWindow(s, "bbbbbb", "seven_day", win(92));
    expect(isAvailable(B, s.accounts.bbbbbb, 90, NOW)).toBe(false);
  });

  it("a window whose reset passed counts as empty", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(99, NOW - 1));
    expect(isAvailable(A, s.accounts.aaaaaa, 90, NOW)).toBe(true);
    expect(headroom(s.accounts.aaaaaa, 90, NOW)).toBe(90);
  });

  it("headroom is the tightest window", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(10));
    recordWindow(s, "aaaaaa", "seven_day", win(70));
    expect(headroom(s.accounts.aaaaaa, 90, NOW)).toBe(20);
  });

  it("keeps the conversation's current account while it is available", () => {
    const s = emptyState();
    recordWindow(s, "bbbbbb", "five_hour", win(80));
    const r = route({ accounts: [A, B], state: s, threshold: 90, now: NOW, current: "bbbbbb" });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
  });

  it("otherwise picks the most headroom, ties by order", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(50));
    recordWindow(s, "bbbbbb", "five_hour", win(20));
    let r = route({ accounts: [A, B, C], state: s, threshold: 90, now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("cccccc"); // no data = 90 headroom
    r = route({ accounts: [A, B], state: s, threshold: 90, now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
    r = route({ accounts: [B, A], state: emptyState(), threshold: 90, now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("aaaaaa");
  });

  it("skips excluded and unavailable accounts and moves off a full current one", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(95));
    const r = route({ accounts: [A, B], state: s, threshold: 90, now: NOW, current: "aaaaaa", exclude: new Set(["cccccc"]) });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
  });

  it("none available returns the earliest moment one frees up", () => {
    const s = emptyState();
    markLimited(s, "aaaaaa", NOW + 500);
    recordWindow(s, "bbbbbb", "five_hour", win(99, NOW + 200));
    expect(nextAvailableAt(B, s.accounts.bbbbbb, 90, NOW)).toBe(NOW + 200);
    expect(route({ accounts: [A, B], state: s, threshold: 90, now: NOW })).toEqual({ kind: "none", retryAt: NOW + 200 });
  });

  it("none with only logged-out accounts has no retry time", () => {
    const s = emptyState();
    setNeedsLogin(s, "aaaaaa", true);
    expect(route({ accounts: [A], state: s, threshold: 90, now: NOW })).toEqual({ kind: "none", retryAt: null });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/router.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import type { Account } from "./accounts.ts";
import type { AccountState, PoolState, WindowState } from "./state.ts";

export type RouteInput = {
  accounts: Account[];
  state: PoolState;
  threshold: number;
  now: number;
  current?: string;
  exclude?: ReadonlySet<string>;
};
export type RouteResult = { kind: "account"; account: Account } | { kind: "none"; retryAt: number | null };

const liveWindows = (st: AccountState | undefined, now: number): WindowState[] =>
  Object.values(st?.windows ?? {}).filter(
    (w): w is WindowState => !!w && (w.resetsAt === null || w.resetsAt > now),
  );

export function isAvailable(account: Account, st: AccountState | undefined, threshold: number, now: number): boolean {
  if (!account.enabled || st?.needsLogin) return false;
  if (st?.limitedUntil != null && st.limitedUntil > now) return false;
  return liveWindows(st, now).every((w) => w.usedPercent < threshold);
}

export function headroom(st: AccountState | undefined, threshold: number, now: number): number {
  return Math.min(threshold, ...liveWindows(st, now).map((w) => threshold - w.usedPercent));
}

export function nextAvailableAt(account: Account, st: AccountState | undefined, threshold: number, now: number): number | null {
  if (!account.enabled || st?.needsLogin) return null;
  let at = now;
  if (st?.limitedUntil != null && st.limitedUntil > at) at = st.limitedUntil;
  for (const w of liveWindows(st, now)) {
    if (w.usedPercent < threshold) continue;
    if (w.resetsAt === null) return null; // full with no known reset
    at = Math.max(at, w.resetsAt);
  }
  return at;
}

export function route(input: RouteInput): RouteResult {
  const { accounts, state, threshold, now, current, exclude } = input;
  const candidates = accounts.filter((a) => !exclude?.has(a.id));
  const available = candidates.filter((a) => isAvailable(a, state.accounts[a.id], threshold, now));
  const sticky = current ? available.find((a) => a.id === current) : undefined;
  if (sticky) return { kind: "account", account: sticky };
  if (available.length > 0) {
    const best = [...available].sort(
      (a, b) =>
        headroom(state.accounts[b.id], threshold, now) - headroom(state.accounts[a.id], threshold, now) ||
        a.order - b.order,
    )[0];
    return { kind: "account", account: best };
  }
  const times = candidates
    .map((a) => nextAvailableAt(a, state.accounts[a.id], threshold, now))
    .filter((t): t is number => t !== null);
  return { kind: "none", retryAt: times.length ? Math.min(...times) : null };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/router.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/router.ts shared/router.test.ts
git commit -m "feat(shared): account router with stickiness, threshold and headroom"
```

---

### Task 8: `shared/creds.ts`

**Files:**
- Create: `shared/creds.ts`, `shared/creds.test.ts`

**Interfaces:**
- Consumes: `keychainService`, `normalizeDir` (Task 3)
- Produces:
  - `type ClaudeCredential = { accessToken: string; expiresAt: number | null; subscriptionType: string | null }`
  - `type ExecFn = (file: string, args: string[]) => Promise<string>` (rejects on a non-zero exit)
  - `parseCredentialBlob(raw: string): ClaudeCredential | null`
  - `readCredential(configDir: string, deps?: { platform?: NodeJS.Platform; home?: string; exec?: ExecFn; readFile?: (path: string) => string }): Promise<ClaudeCredential | null>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseCredentialBlob, readCredential } from "./creds.ts";

const blob = JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: 123, subscriptionType: "pro" }, mcpOAuth: {} });

describe("creds", () => {
  it("parses only claudeAiOauth", () => {
    expect(parseCredentialBlob(blob)).toEqual({ accessToken: "tok", expiresAt: 123, subscriptionType: "pro" });
    expect(parseCredentialBlob("{}")).toBeNull();
    expect(parseCredentialBlob("not json")).toBeNull();
  });

  it("macOS reads the keychain item for the dir", async () => {
    const calls: string[][] = [];
    const cred = await readCredential("/Users/u/.claude-b", {
      platform: "darwin", home: "/Users/u",
      exec: async (file, args) => { calls.push([file, ...args]); return blob + "\n"; },
      readFile: () => { throw new Error("should not read file"); },
    });
    expect(cred?.accessToken).toBe("tok");
    expect(calls[0].slice(0, 3)).toEqual(["security", "find-generic-password", "-s"]);
    expect(calls[0][3]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(calls[0][4]).toBe("-w");
  });

  it("macOS falls back to the credentials file when the keychain has nothing", async () => {
    const cred = await readCredential("/Users/u/.claude", {
      platform: "darwin", home: "/Users/u",
      exec: async () => { throw new Error("exit 44"); },
      readFile: (p) => { expect(p).toBe(join("/Users/u/.claude", ".credentials.json")); return blob; },
    });
    expect(cred?.subscriptionType).toBe("pro");
  });

  it("Windows reads <dir>/.credentials.json and never runs security", async () => {
    const cred = await readCredential("C:\\Users\\u\\.claude-pool\\accounts\\abcdef", {
      platform: "win32", home: "C:\\Users\\u",
      exec: async () => { throw new Error("should not exec"); },
      readFile: (p) => { expect(p.endsWith(".credentials.json")).toBe(true); return blob; },
    });
    expect(cred?.accessToken).toBe("tok");
  });

  it("nothing anywhere is null", async () => {
    const cred = await readCredential("/x", {
      platform: "linux", home: "/home/u",
      exec: async () => "", readFile: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    });
    expect(cred).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test shared/creds.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychainService, normalizeDir } from "./paths.ts";

export type ClaudeCredential = { accessToken: string; expiresAt: number | null; subscriptionType: string | null };
export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, encoding: "utf8", windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

export function parseCredentialBlob(raw: string): ClaudeCredential | null {
  try {
    const oauth = (JSON.parse(raw.trim()) as any)?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/** Read-only. Never logs the token. Keychain first on macOS (the file there is a stale leftover). */
export async function readCredential(
  configDir: string,
  deps: { platform?: NodeJS.Platform; home?: string; exec?: ExecFn; readFile?: (path: string) => string } = {},
): Promise<ClaudeCredential | null> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const dir = platform === "win32" ? configDir : normalizeDir(configDir, home);

  if (platform === "darwin") {
    try {
      const cred = parseCredentialBlob(await exec("security", ["find-generic-password", "-s", keychainService(dir, home), "-w"]));
      if (cred) return cred;
    } catch {
      // no item, or access denied: try the file
    }
  }
  try {
    return parseCredentialBlob(readFile(join(dir, ".credentials.json")));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test shared/creds.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/creds.ts shared/creds.test.ts
git commit -m "feat(shared): read-only Claude credential lookup for macOS and Windows"
```

---

### Task 9: Plugin registers pool and per-account providers

**Files:**
- Create: `plugin/src/pool.ts`, `plugin/test/pool-providers-regression.ts`
- Modify: `plugin/src/index.ts` (provider registration, hook, integration removal, fallback handler, accounts watch)
- Modify: `plugin/src/constants.ts` (add `ACCOUNT_HEADER`)
- Modify: `plugin/test/config-dirs-regression.ts` (remove the `configDirForDirectory` asserts at its top)
- Modify: `plugin/src/config-dir.ts` (delete `configDirForDirectory`; keep `claudeConfigDir`)

**Interfaces:**
- Consumes: `readAccounts`, `enabledAccounts`, `AccountsFile` (Task 5); `poolDataDir`, `accountsFile` (Task 3)
- Produces:
  - `POOL_PROVIDER_ID = "claude-pool"`; `ACCOUNT_HEADER = "x-claude-pool-account"` (in `constants.ts`)
  - `accountProviderId(id: string): string` → `claude-pool-<id>`
  - `accountFromProviderId(providerID: string): "pool" | string | null` (`"pool"`, an account id, or `null` for foreign providers)
  - `type PoolProviderSpec = { id: string; name: string }`
  - `poolProviderSpecs(file: AccountsFile): PoolProviderSpec[]`
  - `buildProviderInfo(baseURL: string, spec: PoolProviderSpec)` and `buildClaudeProviderModels(models, providerID: string, compactAt?)` (signatures change in `index.ts`)
  - `watchAccounts(onChange: () => void, dataDir?: string): () => void`

- [ ] **Step 1: Write the failing test** (`plugin/test/pool-providers-regression.ts`)

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun plugin/test/pool-providers-regression.ts`
Expected: FAIL, `Cannot find module '../src/pool.ts'`

- [ ] **Step 3: Add the header constant** (`plugin/src/constants.ts`, append)

```ts
/** Which Claude Pool account a request uses: "pool" or a 6-hex account id. */
export const ACCOUNT_HEADER = "x-claude-pool-account";
export const POOL_PROVIDER_ID = "claude-pool";
```

Leave `PROVIDER_ID` in place for now; Step 5 removes every remaining use.

- [ ] **Step 4: Write `plugin/src/pool.ts`**

```ts
import { watch } from "node:fs";
import { mkdirSync } from "node:fs";
import { enabledAccounts, type AccountsFile } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { POOL_PROVIDER_ID } from "./constants.js";

export type PoolProviderSpec = { id: string; name: string };

export const accountProviderId = (id: string): string => `${POOL_PROVIDER_ID}-${id}`;

export function accountFromProviderId(providerID: string): "pool" | string | null {
  if (providerID === POOL_PROVIDER_ID) return "pool";
  const m = /^claude-pool-([0-9a-f]{6})$/.exec(providerID);
  return m ? m[1] : null;
}

export function poolProviderSpecs(file: AccountsFile): PoolProviderSpec[] {
  const enabled = enabledAccounts(file);
  if (enabled.length === 0) return [];
  return [
    { id: POOL_PROVIDER_ID, name: "Claude Pool" },
    ...enabled.map((a) => ({ id: accountProviderId(a.id), name: `Claude · ${a.label}` })),
  ];
}

/** Event-driven: fires (debounced) when accounts.json is replaced. No polling. */
export function watchAccounts(onChange: () => void, dataDir: string = poolDataDir()): () => void {
  mkdirSync(dataDir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dataDir, (_event, name) => {
    if (name && name !== "accounts.json") return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });
  watcher.unref?.();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
```

- [ ] **Step 5: Modify `plugin/src/index.ts`**

1. Imports: remove `configDirForDirectory`, `PROVIDER_ID`, `CONFIG_DIR_HEADER`, `startClaudeCliLogin`, `submitClaudeCliLoginCode`, `installClaudeCli`. Add:

```ts
import { readAccounts } from "../../shared/accounts.ts";
import { ACCOUNT_HEADER, POOL_PROVIDER_ID } from "./constants.js";
import { accountFromProviderId, poolProviderSpecs, watchAccounts, type PoolProviderSpec } from "./pool.js";
```

2. Change `applyClaudeRequestContextHeaders` to drop the `configDir` parameter (the proxy now sets the config dir):

```ts
export function applyClaudeRequestContextHeaders(headers: Record<string, string>, directory: string, sessionID?: string): void {
  headers[DIRECTORY_HEADER] = encodeURIComponent(directory);
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}
```

In `plugin/test/config-dirs-regression.ts`, replace the `send` helper's `applyClaudeRequestContextHeaders(headers, cwd, session, configDir)` with:

```ts
applyClaudeRequestContextHeaders(headers, cwd, session);
if (configDir) headers["x-opencode-claude-config-dir"] = encodeURIComponent(configDir);
```

and delete the `configDirForDirectory` import and its eight `assert.equal(configDirForDirectory(...))` lines.

3. `buildProviderModel(model, id, compactAt)` → `buildProviderModel(model, id, providerID: string, compactAt?)`, and set `providerID` from the argument. `buildClaudeProviderModels(models, providerID: string, compactAt?)` passes it through.

4. `buildProviderInfo(baseURL: string, spec: PoolProviderSpec)`:

```ts
export function buildProviderInfo(baseURL: string, spec: PoolProviderSpec): ProviderInfo {
  return {
    id: spec.id,
    name: spec.name,
    // Accounts are managed by the Claude Pool extension, not an OpenCode credential.
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: { baseURL, provider: spec.id, apiKey: "claude-pool-proxy" },
  } as unknown as ProviderInfo;
}
```

5. In `setup`: delete the `configDir` computation. Replace the `ctx.provider.transform(...)` block with:

```ts
await ctx.provider.transform((providers) => {
  const compactAt = (ctx.options as { compactAt?: unknown } | undefined)?.compactAt;
  for (const spec of poolProviderSpecs(readAccounts())) {
    providers.add({
      info: buildProviderInfo(currentProxyBaseUrl(), spec),
      models: buildClaudeProviderModels(getClaudeModels(), spec.id, compactAt),
    });
  }
});
```

6. Replace the `model.request` hook with an unscoped one that ignores foreign providers and remembers each session's provider:

```ts
const sessionProvider = new Map<string, string>();
await ctx.session.hook("model.request", async (request) => {
  const account = accountFromProviderId(request.model.providerID);
  if (account === null) return;
  await startProxy();
  request.baseURL = getClaudeProxyBaseUrl();
  const selected = resolveClaudeModelSelection(request.model.id, request.model.variant);
  request.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
  request.headers[KIND_HEADER] = request.kind;
  request.headers[ACCOUNT_HEADER] = account;
  applyClaudeRequestContextHeaders(request.headers, directory, request.sessionID);
  sessionProvider.set(request.sessionID, request.model.providerID);
});
```

(If `request.model.providerID` does not type-check, use `(request.model as { providerID: string }).providerID`. `Model.Ref` carries `providerID`.)

7. Delete the `ctx.integration.transform(...)` block and the functions it alone used: `buildAuthMethods`, `cliSignInMarker`, `alreadySignedInResponse`, `relayOrFallback`, `manualInstallResponse`, `waitForCliLogin`, `INSTALL_METHOD_ID`, `SIGN_IN_METHOD_ID`. Keep `probeCliPresence` (the model refresh uses it).

8. Change the fallback handler to use the session's provider:

```ts
setModelFallbackHandler((sessionID, modelId, variant) => {
  const providerID = sessionProvider.get(sessionID) ?? POOL_PROVIDER_ID;
  void ctx.session
    .switchModel({ sessionID, model: { id: modelId, providerID, ...(variant ? { variant } : {}) } })
    .catch((err: unknown) => log.warn("[claude-pool] could not switch the session to the fallback model", err instanceof Error ? err.message : err));
});
```

9. Reload providers when accounts change. Add this before `return`:

```ts
const stopAccountsWatch = watchAccounts(() => {
  void ctx.provider.reload().catch((err: unknown) =>
    log.warn("[claude-pool] provider reload failed", err instanceof Error ? err.message : err),
  );
});
```

and call `stopAccountsWatch()` in the returned cleanup.

10. Change the plugin id to `id: "claude-pool"`.

- [ ] **Step 6: Delete `configDirForDirectory` from `plugin/src/config-dir.ts`** (keep `claudeConfigDir` and `expandHome`).

- [ ] **Step 7: Find and fix remaining references**

Run: `grep -rn "PROVIDER_ID\b\|buildAuthMethods\|configDirForDirectory\|manualInstallResponse" plugin/src plugin/test`
Expected: only the `PROVIDER_ID` definition in `constants.ts`. Delete it. Tests that exercised only the removed sign-in methods: delete those test blocks (in `smoke.ts`, the blocks that call `buildAuthMethods` / `manualInstallResponse`). Tests that use `buildProviderInfo`/`buildClaudeProviderModels`: pass `{ id: "claude-pool", name: "Claude Pool" }` / `"claude-pool"` as the new arguments, and expect `claude-pool` where they expected `claude-code`.

- [ ] **Step 8: Run the new test and the full plugin suite**

Run: `bun plugin/test/pool-providers-regression.ts && bun run test:plugin`
Expected: `ok — pool providers regression passed`, then all `pass`.

- [ ] **Step 9: Commit**

```bash
git add -A plugin
git commit -m "feat(plugin): register claude-pool and per-account providers from accounts.json"
```

---

### Task 10: Rate-limit events update `state.json`

**Files:**
- Modify: `plugin/src/rate-limit.ts` (listener hook in `writeState`)
- Create: `plugin/src/pool-state-bridge.ts`, `plugin/test/pool-state-bridge-regression.ts`

**Interfaces:**
- Consumes: `findByConfigDir`, `readAccounts` (Task 5); `updateState`, `recordWindow`, `markLimited`, `windowNameFromRateLimitType`, `toPercent` (Task 6)
- Produces:
  - in `rate-limit.ts`: `setRateLimitListener(fn: ((configDir: string | undefined, state: ClaudeRateLimitState) => void) | null): void`
  - `installPoolStateBridge(dataDir?: string): void` (idempotent; registers the listener)
  - `applyRateLimitToPool(configDir: string | undefined, rl: ClaudeRateLimitState, dataDir?: string): void`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun plugin/test/pool-state-bridge-regression.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Add the listener to `rate-limit.ts`.** Next to the module's other top-level declarations, add:

```ts
type RateLimitListener = (configDir: string | undefined, state: ClaudeRateLimitState) => void;
let rateLimitListener: RateLimitListener | null = null;
export function setRateLimitListener(fn: RateLimitListener | null): void {
  rateLimitListener = fn;
}
```

At the end of the `try` block in `writeState(state, configDir)`, after the file write succeeds, add:

```ts
try {
  rateLimitListener?.(configDir, state);
} catch {
  // the pool bridge must never break the proxy
}
```

- [ ] **Step 4: Write `plugin/src/pool-state-bridge.ts`**

```ts
import { findByConfigDir, readAccounts } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { markLimited, recordWindow, toPercent, updateState, windowNameFromRateLimitType } from "../../shared/state.ts";
import { setRateLimitListener, type ClaudeRateLimitState } from "./rate-limit.js";
import { log } from "./log.js";

export function applyRateLimitToPool(configDir: string | undefined, rl: ClaudeRateLimitState, dataDir: string = poolDataDir()): void {
  const account = findByConfigDir(readAccounts(dataDir), configDir);
  if (!account) return;
  const name = windowNameFromRateLimitType(rl.rateLimitType);
  const hasWindow = name !== undefined && typeof rl.utilization === "number";
  const limited = rl.limited && typeof rl.limitedUntil === "number" && rl.limitedUntil > Date.now();
  if (!hasWindow && !limited) return;
  updateState((s) => {
    if (hasWindow) {
      recordWindow(s, account.id, name!, {
        usedPercent: toPercent(rl.utilization!),
        resetsAt: rl.resetsAt ?? null,
        updatedAt: rl.updatedAt,
      });
    }
    if (limited) markLimited(s, account.id, rl.limitedUntil!);
  }, dataDir);
}

let installedFor: string | undefined;
export function installPoolStateBridge(dataDir: string = poolDataDir()): void {
  if (installedFor === dataDir) return;
  installedFor = dataDir;
  setRateLimitListener((configDir, state) => {
    try {
      applyRateLimitToPool(configDir, state, dataDir);
    } catch (err) {
      log.warn("[claude-pool] could not record a rate limit in state.json", err instanceof Error ? err.message : err);
    }
  });
}
```

If `ClaudeRateLimitState` is not exported from `rate-limit.ts`, export it (it is declared `export type` at the top of the file).

- [ ] **Step 5: Install the bridge when the proxy starts.** In `plugin/src/proxy.ts`, inside `startProxy()` before the listener binds, add `installPoolStateBridge();` with the import `import { installPoolStateBridge } from "./pool-state-bridge.js";`.

- [ ] **Step 6: Run the test and the suite**

Run: `bun plugin/test/pool-state-bridge-regression.ts && bun run test:plugin`
Expected: `ok — pool state bridge regression passed`, all `pass`.

- [ ] **Step 7: Commit**

```bash
git add -A plugin
git commit -m "feat(plugin): mirror rate-limit events into the pool state"
```

---

### Task 11: Pool routing and failover in the proxy

**Files:**
- Create: `plugin/src/pool-proxy.ts`, `plugin/test/pool-failover-regression.ts`
- Modify: `plugin/src/proxy.ts` (the one call site at `/v1/chat/completions`)

**Interfaces:**
- Consumes: `readAccounts`, `enabledAccounts` (Task 5); `readState`, `updateState`, `bindConversation`, `markLimited` (Task 6); `route` (Task 7); `isDefaultConfigDir` (Task 3); `ACCOUNT_HEADER`, `CONFIG_DIR_HEADER`, `SESSION_HEADER` (constants)
- Produces:
  - `type ChatHandler = (req: Request, body: any) => Promise<Response>`
  - `handlePoolChat(req: Request, body: any, handle: ChatHandler, dataDir?: string): Promise<Response>`
  - `withAccountDir(req: Request, configDir: string): Request`
  - `limitFromResponse(res: Response): Promise<{ until: number } | null>`
  - `poolLimitResponse(retryAt: number | null): Response`
  - optional hook used by Task 12: `setMigrationHook(fn: ((sessionKey: string, fromDir: string, toDir: string) => void) | null): void`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Regression: pool routing. Fixed providers use their account's dir; the pool
 * picks by headroom, sticks to a conversation, reruns a turn on another
 * account when one hits its limit before output, and answers 429 with the
 * earliest reset when every account is limited.
 * Run: bun plugin/test/pool-failover-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "pool-failover-"));
process.env.CLAUDE_POOL_HOME = home;
const A_DIR = join(homedir(), ".claude");
const B_DIR = mkdtempSync(join(tmpdir(), "pool-b-"));
const C_DIR = mkdtempSync(join(tmpdir(), "pool-c-"));

const { updateAccounts } = await import("../../shared/accounts.ts");
const { readState, updateState, recordWindow, markLimited } = await import("../../shared/state.ts");
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
  limitedDirs.add(B_DIR);
  seenDirs.length = 0;
  res = await send("pool", "s-pool");
  assert.equal(res.status, 200, "rerun answered 200");
  await res.text();
  assert.deepEqual(seenDirs, [B_DIR, C_DIR]);
  assert.ok((readState(home).accounts.bbbbbb.limitedUntil ?? 0) > Date.now());
  assert.equal(readState(home).conversations["s-pool"].accountId, "cccccc");

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
} finally {
  proxy.setClaudeQueryStarter(null);
  await proxy.stopProxy();
}
console.log("ok — pool failover regression passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun plugin/test/pool-failover-regression.ts`
Expected: FAIL (the header is ignored, so case 2 sees `undefined`).

- [ ] **Step 3: Write `plugin/src/pool-proxy.ts`**

```ts
import { enabledAccounts, readAccounts, type Account } from "../../shared/accounts.ts";
import { isDefaultConfigDir, poolDataDir } from "../../shared/paths.ts";
import { route } from "../../shared/router.ts";
import { bindConversation, markLimited, readState, updateState } from "../../shared/state.ts";
import { ACCOUNT_HEADER, CONFIG_DIR_HEADER, SESSION_HEADER } from "./constants.js";
import { log } from "./log.js";

export type ChatHandler = (req: Request, body: any) => Promise<Response>;

type MigrationHook = (sessionKey: string, fromDir: string, toDir: string) => void;
let migrationHook: MigrationHook | null = null;
export function setMigrationHook(fn: MigrationHook | null): void {
  migrationHook = fn;
}

/** The default dir runs without CLAUDE_CONFIG_DIR, so it keeps its own Keychain item. */
export function withAccountDir(req: Request, configDir: string): Request {
  const headers = new Headers(req.headers);
  if (isDefaultConfigDir(configDir)) headers.delete(CONFIG_DIR_HEADER);
  else headers.set(CONFIG_DIR_HEADER, encodeURIComponent(configDir));
  return new Request(req.url, { method: req.method, headers });
}

export async function limitFromResponse(res: Response): Promise<{ until: number } | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as any;
    if (body?.error?.code !== "claude_session_limit") return null;
    const resetsAt = body.error.resets_at ? Date.parse(body.error.resets_at) : NaN;
    const retryAfter = Number(body.error.retry_after ?? res.headers.get("retry-after"));
    const until = Number.isFinite(resetsAt)
      ? resetsAt
      : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600_000);
    return { until };
  } catch {
    return null;
  }
}

export function poolLimitResponse(retryAt: number | null): Response {
  const seconds = retryAt === null ? 600 : Math.max(1, Math.round((retryAt - Date.now()) / 1000));
  const message =
    retryAt === null
      ? "Every Claude Pool account is limited or signed out. Sign in again in the Claude Pool panel."
      : `Every Claude Pool account is at its limit. The first one frees up at ${new Date(retryAt).toISOString()}.`;
  return Response.json(
    {
      error: {
        message,
        type: "rate_limit_error",
        code: "claude_session_limit",
        retry_after: seconds,
        ...(retryAt !== null ? { resets_at: new Date(retryAt).toISOString() } : {}),
      },
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

const badAccount = (id: string) =>
  Response.json(
    { error: { message: `Claude Pool account ${id} is not configured or is disabled. Open the Claude Pool panel.`, type: "invalid_request_error" } },
    { status: 400 },
  );

export async function handlePoolChat(req: Request, body: any, handle: ChatHandler, dataDir: string = poolDataDir()): Promise<Response> {
  const tag = req.headers.get(ACCOUNT_HEADER);
  if (!tag) return handle(req, body);

  const file = readAccounts(dataDir);
  const enabled = enabledAccounts(file);

  if (tag !== "pool") {
    const account = enabled.find((a) => a.id === tag);
    return account ? handle(withAccountDir(req, account.configDir), body) : badAccount(tag);
  }
  if (enabled.length === 0) return badAccount("pool");

  const sessionKey = req.headers.get(SESSION_HEADER) ?? undefined;
  const tried = new Set<string>();
  let previous: Account | undefined;
  {
    const bound = sessionKey ? readState(dataDir).conversations[sessionKey]?.accountId : undefined;
    previous = bound ? enabled.find((a) => a.id === bound) : undefined;
  }

  for (let attempt = 0; attempt < enabled.length; attempt++) {
    const now = Date.now();
    const choice = route({ accounts: enabled, state: readState(dataDir), threshold: file.threshold, now, current: previous?.id, exclude: tried });
    if (choice.kind === "none") return poolLimitResponse(choice.retryAt);
    const account = choice.account;

    if (sessionKey) {
      if (previous && previous.id !== account.id && migrationHook) {
        try {
          migrationHook(sessionKey, previous.configDir, account.configDir);
        } catch (err) {
          log.warn("[claude-pool] transcript migration failed; history will be replayed", err instanceof Error ? err.message : err);
        }
      }
      updateState((s) => bindConversation(s, sessionKey, account.id, now), dataDir);
    }

    const res = await handle(withAccountDir(req, account.configDir), body);
    const limit = await limitFromResponse(res);
    if (!limit) return res;

    log.info("[claude-pool] account hit its limit; trying the next one", { account: account.id });
    updateState((s) => markLimited(s, account.id, limit.until), dataDir);
    tried.add(account.id);
    previous = account;
  }
  const state = readState(dataDir);
  const route2 = route({ accounts: enabled, state, threshold: file.threshold, now: Date.now() });
  return poolLimitResponse(route2.kind === "none" ? route2.retryAt : null);
}
```

- [ ] **Step 4: Wire it into the proxy.** In `plugin/src/proxy.ts`, in `handleRequest`, replace

```ts
return await handleChatCompletions(req, body);
```

with

```ts
return await handlePoolChat(req, body, handleChatCompletions);
```

and add `import { handlePoolChat } from "./pool-proxy.js";`.

The existing gate keys on `conversationKey + messages.length` and on the config dir. A rerun goes to a different config dir, whose gate is not blocked, so the rerun is not refused. A mid-stream limit keeps the existing retryable stream error. OpenCode's retry then arrives with `ACCOUNT_HEADER: pool`, and the router excludes the account the bridge marked limited (Task 10).

- [ ] **Step 5: Run the test and the suite**

Run: `bun plugin/test/pool-failover-regression.ts && bun run test:plugin`
Expected: `ok — pool failover regression passed`, all `pass`.

- [ ] **Step 6: Commit**

```bash
git add -A plugin
git commit -m "feat(plugin): pool routing with in-proxy failover across accounts"
```

---

### Task 12: Move the Claude transcript when a conversation changes account

**Files:**
- Create: `plugin/src/migrate.ts`, `plugin/test/pool-migrate-regression.ts`
- Modify: `plugin/src/proxy.ts` (register the hook in `startProxy`)

**Interfaces:**
- Consumes: `findClaudeSessionFile(sessionId, configDir?)` and `getForeignSessionId(conversationKey)` from `session-store.ts`; `setMigrationHook` (Task 11)
- Produces:
  - `migrateTranscript(sessionId: string, fromDir: string, toDir: string): boolean`
  - `installTranscriptMigration(): void`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Regression: a transcript (and its sidecar folder) is copied to the new
 * account's projects folder under the same relative path, never over a newer file.
 * Run: bun plugin/test/pool-migrate-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pool-mig-xdg-"));
const { migrateTranscript } = await import("../src/migrate.ts");
const from = mkdtempSync(join(tmpdir(), "pool-from-"));
const to = mkdtempSync(join(tmpdir(), "pool-to-"));
const SID = "11111111-2222-3333-4444-555555555555";

mkdirSync(join(from, "projects", "-src-app"), { recursive: true });
writeFileSync(join(from, "projects", "-src-app", `${SID}.jsonl`), '{"uuid":"a"}\n');
mkdirSync(join(from, "projects", "-src-app", SID, "subagents"), { recursive: true });
writeFileSync(join(from, "projects", "-src-app", SID, "subagents", "x.jsonl"), "{}\n");

assert.equal(migrateTranscript(SID, from, to), true);
assert.equal(readFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), "utf8"), '{"uuid":"a"}\n');
assert.ok(existsSync(join(to, "projects", "-src-app", SID, "subagents", "x.jsonl")));

// newer destination is kept
writeFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), '{"uuid":"newer"}\n');
const future = new Date(Date.now() + 60_000);
utimesSync(join(to, "projects", "-src-app", `${SID}.jsonl`), future, future);
assert.equal(migrateTranscript(SID, from, to), true);
assert.equal(readFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), "utf8"), '{"uuid":"newer"}\n');

assert.equal(migrateTranscript("missing-session", from, to), false);
console.log("ok — pool migrate regression passed");
process.exit(0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun plugin/test/pool-migrate-regression.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `plugin/src/migrate.ts`**

```ts
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findClaudeSessionFile, getForeignSessionId } from "./session-store.js";
import { setMigrationHook } from "./pool-proxy.js";
import { log } from "./log.js";

export function migrateTranscript(sessionId: string, fromDir: string, toDir: string): boolean {
  const src = findClaudeSessionFile(sessionId, fromDir);
  if (!src) return false;
  const rel = relative(join(fromDir, "projects"), src);
  if (rel.startsWith("..")) return false;
  const dest = join(toDir, "projects", rel);
  if (!(existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  const sidecar = join(dirname(src), sessionId);
  if (existsSync(sidecar)) cpSync(sidecar, join(dirname(dest), sessionId), { recursive: true, force: false, errorOnExist: false });
  return true;
}

export function installTranscriptMigration(): void {
  setMigrationHook((sessionKey, fromDir, toDir) => {
    const sid = getForeignSessionId(sessionKey);
    if (!sid) return;
    const moved = migrateTranscript(sid, fromDir, toDir);
    log.info("[claude-pool] moved the Claude session to the new account", { sessionKey, moved });
  });
}
```

If `findClaudeSessionFile` takes its arguments in a different order, adapt the call. Check with `grep -n "export function findClaudeSessionFile" plugin/src/session-store.ts`. When it returns null, the proxy already falls back to replaying history (`proxy.ts` "stored Claude session file missing").

- [ ] **Step 4: Register in `startProxy()`** next to `installPoolStateBridge()`: `installTranscriptMigration();` with `import { installTranscriptMigration } from "./migrate.js";`.

- [ ] **Step 5: Extend `pool-failover-regression.ts` case 4.** Before step 4 of that test, bind a foreign session and write its transcript under `B_DIR`, then assert it now exists under `C_DIR`:

```ts
const { setForeignSessionId } = await import("../src/session-store.ts");
const SID = "99999999-0000-0000-0000-000000000000";
const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
mkdirSync(join(B_DIR, "projects", "p"), { recursive: true });
writeFileSync(join(B_DIR, "projects", "p", `${SID}.jsonl`), '{"uuid":"leaf"}\n');
setForeignSessionId("s-pool", SID, { cwd: home, leafUuid: "leaf" });
```

and after the case-4 asserts:

```ts
assert.ok(existsSync(join(C_DIR, "projects", "p", `${SID}.jsonl`)), "transcript followed the conversation");
```

- [ ] **Step 6: Run both and the suite**

Run: `bun plugin/test/pool-migrate-regression.ts && bun plugin/test/pool-failover-regression.ts && bun run test:plugin`
Expected: all `ok`/`pass`.

- [ ] **Step 7: Commit**

```bash
git add -A plugin
git commit -m "feat(plugin): carry the Claude transcript to the new account on failover"
```

---

### Task 13: Service skeleton, routing and the extension check

**Files:**
- Create: `service/src/main.ts`, `service/src/http.ts`, `service/src/main.test.ts`
- Create (built): `service/main.js`

**Interfaces:**
- Produces:
  - `type Route = (req: { method: string; path: string; query: URLSearchParams; body: string }) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }`
  - `createServer(routes: Record<string, Route>, token: string): http.Server` (key `"METHOD /path"`; a `:id` segment is matched and exposed as `query.get("id")`)
  - Service routes registered in `main.ts`: `GET /health`, `POST /quota` (Task 14), `/api/*` (Tasks 15–16)

- [ ] **Step 1: Write the failing test** (`service/src/main.test.ts`)

```ts
import { afterAll, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import { createServer } from "./http.ts";

const server = createServer(
  {
    "GET /health": () => ({ status: 200, body: { ok: true } }),
    "PATCH /api/accounts/:id": (r) => ({ status: 200, body: { id: r.query.get("id"), body: JSON.parse(r.body) } }),
  },
  "secret",
);
server.listen(0, "127.0.0.1");
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

describe("service http", () => {
  it("refuses a missing or wrong bearer", async () => {
    expect((await fetch(`${base()}/health`)).status).toBe(401);
    expect((await fetch(`${base()}/health`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("routes with the bearer", async () => {
    const res = await fetch(`${base()}/health`, { headers: { authorization: "Bearer secret" } });
    expect(await res.json()).toEqual({ ok: true });
  });
  it("matches :id segments", async () => {
    const res = await fetch(`${base()}/api/accounts/abcdef`, { method: "PATCH", headers: { authorization: "Bearer secret" }, body: '{"label":"x"}' });
    expect(await res.json()).toEqual({ id: "abcdef", body: { label: "x" } });
  });
  it("unknown route is 404, a throwing route is 500 with a message", async () => {
    expect((await fetch(`${base()}/nope`, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test service/src/main.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `service/src/http.ts`**

```ts
import http from "node:http";

export type RouteRequest = { method: string; path: string; query: URLSearchParams; body: string };
export type RouteResult = { status: number; body: unknown };
export type Route = (req: RouteRequest) => Promise<RouteResult> | RouteResult;

function match(routes: Record<string, Route>, method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const [key, route] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const a = pattern.split("/"), b = path.split("/");
    if (a.length !== b.length) continue;
    const params: Record<string, string> = {};
    if (a.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) {
      return { route, params };
    }
  }
  return null;
}

export function createServer(routes: Record<string, Route>, token: string): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const found = match(routes, req.method ?? "GET", url.pathname);
    if (!found) return send(404, { error: "not-found" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      for (const [k, v] of Object.entries(found.params)) url.searchParams.set(k, v);
      try {
        const out = await found.route({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
        send(out.status, out.body);
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}
```

- [ ] **Step 4: Implement `service/src/main.ts`** (the routes from Tasks 14–16 are added there)

```ts
import { createServer, type Route } from "./http.ts";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}

export const routes: Record<string, Route> = {
  "GET /health": () => ({ status: 200, body: { ok: true } }),
};

createServer(routes, token).listen(port, "127.0.0.1");
```

- [ ] **Step 5: Run the test, build, and run the guest check**

Run: `bun test service/src/main.test.ts && bun scripts/build.ts service && bunx openchamber-guest-check .`
Expected: PASS. The build writes `service/main.js`. The check reports the manifest valid. If it reports missing `ui/panel/index.html` or `ui/status/index.html`, create both now as placeholders (`<!doctype html><html><body><div id="root"></div><script type="module" src="main.js"></script></body></html>`) with an empty `main.ts`, build `ui`, and run the check again. Tasks 17–18 replace them.

- [ ] **Step 6: Commit**

```bash
git add service ui scripts package.json
git commit -m "feat(service): authenticated loopback service skeleton"
```

---

### Task 14: Usage reads and the quota answer

**Files:**
- Create: `service/src/usage.ts`, `service/src/usage.test.ts`, `service/src/quota.ts`, `service/src/quota.test.ts`
- Modify: `service/src/main.ts` (register `POST /quota`)

**Interfaces:**
- Consumes: `readCredential` (Task 8); `readAccounts`, `enabledAccounts` (Task 5); `readState`, `updateState`, `recordWindow`, `setNeedsLogin` (Task 6); `route` (Task 7); `readQuotaProviderRequest`, `QuotaProviderUsageData` from `@openchamber/sdk`; `quotaProviderSchemasV1` from `@openchamber/sdk/schemas` (tests)
- Produces:
  - `type UsageRead = { ok: true; windows: Partial<Record<"five_hour" | "seven_day", { usedPercent: number; resetsAt: number | null }>>; plan: string | null } | { ok: false; error: string; needsLogin?: boolean; plan: string | null }`
  - `parseUsagePayload(payload: unknown): UsageRead & { ok: true }`
  - `readAccountUsage(account: Account, deps?: { fetch?: typeof fetch; readCredential?: typeof readCredential; now?: () => number }): Promise<UsageRead>` (per-account cooldown after a 429)
  - `refreshAllUsage(dataDir?: string, deps?): Promise<Record<string, UsageRead>>` (writes `state.json`)
  - `buildQuotaAnswer(input: { accounts: Account[]; state: PoolState; threshold: number; now: number; reads: Record<string, UsageRead> }): QuotaProviderUsageData`

- [ ] **Step 1: Write the failing usage test** (`service/src/usage.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { parseUsagePayload, readAccountUsage } from "./usage.ts";

const account = { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true };
const cred = async () => ({ accessToken: "tok", expiresAt: null, subscriptionType: "pro" });

describe("usage", () => {
  it("reads the limits array", () => {
    const r = parseUsagePayload({ limits: [
      { kind: "session", percent: 42, resets_at: "2026-11-18T20:00:00Z" },
      { kind: "weekly_all", percent: 71, resets_at: "2026-11-22T00:00:00Z" },
    ] });
    expect(r.windows.five_hour).toEqual({ usedPercent: 42, resetsAt: Date.parse("2026-11-18T20:00:00Z") });
    expect(r.windows.seven_day?.usedPercent).toBe(71);
  });

  it("falls back to legacy fields", () => {
    const r = parseUsagePayload({ five_hour: { utilization: 12, resets_at: "2026-11-18T20:00:00Z" }, seven_day: { utilization: 3, resets_at: null } });
    expect(r.windows.five_hour?.usedPercent).toBe(12);
    expect(r.windows.seven_day).toEqual({ usedPercent: 3, resetsAt: null });
  });

  it("sends the bearer and beta header; 401 means needsLogin", async () => {
    let seen: Headers | undefined;
    const ok = await readAccountUsage(account, { readCredential: cred, fetch: (async (_u: any, init: any) => { seen = new Headers(init.headers); return Response.json({ limits: [] }); }) as any });
    expect(seen?.get("authorization")).toBe("Bearer tok");
    expect(seen?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(ok.ok).toBe(true);
    const denied = await readAccountUsage({ ...account, id: "bbbbbb" }, { readCredential: cred, fetch: (async () => new Response("", { status: 401 })) as any });
    expect(denied).toMatchObject({ ok: false, needsLogin: true });
  });

  it("no credential is a sign-in error; an expired token is reported, not refreshed", async () => {
    expect(await readAccountUsage({ ...account, id: "cccccc" }, { readCredential: async () => null })).toMatchObject({ ok: false, needsLogin: true });
    const expired = await readAccountUsage({ ...account, id: "dddddd" }, { now: () => 10, readCredential: async () => ({ accessToken: "t", expiresAt: 5, subscriptionType: "max" }), fetch: (async () => { throw new Error("must not call"); }) as any });
    expect(expired).toMatchObject({ ok: false, plan: "max" });
  });

  it("a 429 starts a cooldown for that account only", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "120" } }); }) as any;
    const acc = { ...account, id: "eeeeee" };
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 });
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 2000 });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Write the failing quota test** (`service/src/quota.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { quotaProviderSchemasV1 } from "@openchamber/sdk/schemas";
import { emptyState, recordWindow, setNeedsLogin } from "../../shared/state.ts";
import { buildQuotaAnswer } from "./quota.ts";

const A = { id: "aaaaaa", label: "work", configDir: "/a", order: 0, enabled: true };
const B = { id: "bbbbbb", label: "home", configDir: "/b", order: 1, enabled: true };
const NOW = Date.parse("2026-11-18T12:00:00Z");
const RESET = NOW + 3600_000;

describe("quota answer", () => {
  it("routed account on top, one group per account, plan summary, schema-valid", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 80, resetsAt: RESET, updatedAt: NOW });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 10, resetsAt: RESET, updatedAt: NOW });
    recordWindow(s, "bbbbbb", "seven_day", { usedPercent: 30, resetsAt: RESET, updatedAt: NOW });
    const data = buildQuotaAnswer({
      accounts: [A, B], state: s, threshold: 90, now: NOW,
      reads: { aaaaaa: { ok: true, windows: {}, plan: "pro" }, bbbbbb: { ok: true, windows: {}, plan: "max" } },
    });
    expect(data.ok).toBe(true);
    expect(data.usage?.windows["5h"]).toMatchObject({ usedPercent: 10, windowSeconds: 18000, resetAt: RESET, valueLabel: "home" });
    expect(Object.keys(data.usage?.models ?? {})).toEqual(["work", "home"]);
    expect(data.usage?.models?.home.windows["7d"].usedPercent).toBe(30);
    expect(data.planLabel).toBe("Pro ×1, Max ×1");
    expect(quotaProviderSchemasV1.data["usage.read"].safeParse(data).success).toBe(true);
  });

  it("a signed-out account shows in its group label and the card still answers", () => {
    const s = emptyState();
    setNeedsLogin(s, "aaaaaa", true);
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 5, resetsAt: RESET, updatedAt: NOW });
    const data = buildQuotaAnswer({ accounts: [A, B], state: s, threshold: 90, now: NOW, reads: { aaaaaa: { ok: false, error: "expired", needsLogin: true, plan: null }, bbbbbb: { ok: true, windows: {}, plan: "pro" } } });
    expect(data.ok).toBe(true);
    expect(Object.keys(data.usage?.models ?? {})).toContain("work (sign in again)");
  });

  it("no data at all is ok:false with the first error", () => {
    const data = buildQuotaAnswer({ accounts: [A], state: emptyState(), threshold: 90, now: NOW, reads: { aaaaaa: { ok: false, error: "network down", plan: null } } });
    expect(data).toMatchObject({ ok: false, configured: true });
    expect(data.error).toContain("network down");
  });

  it("no accounts is configured:true with a pointer to the panel", () => {
    const data = buildQuotaAnswer({ accounts: [], state: emptyState(), threshold: 90, now: NOW, reads: {} });
    expect(data).toMatchObject({ ok: false, configured: true });
    expect(data.error).toMatch(/Claude Pool panel/);
  });
});
```

If `quotaProviderSchemasV1.data["usage.read"]` is not the exported path, find it with `grep -n "quotaDataSchemas\|quotaProviderSchemasV1 =" node_modules/@openchamber/sdk/dist/service-provider-schemas.js` and use the exported key that maps `usage.read`.

- [ ] **Step 3: Run both and confirm they fail**

Run: `bun test service/src/usage.test.ts service/src/quota.test.ts`
Expected: FAIL, modules not found

- [ ] **Step 4: Implement `service/src/usage.ts`**

```ts
import type { Account } from "../../shared/accounts.ts";
import { enabledAccounts, readAccounts } from "../../shared/accounts.ts";
import { readCredential as defaultReadCredential } from "../../shared/creds.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { recordWindow, setNeedsLogin, updateState } from "../../shared/state.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

type Win = { usedPercent: number; resetsAt: number | null };
export type UsageRead =
  | { ok: true; windows: Partial<Record<"five_hour" | "seven_day", Win>>; plan: string | null }
  | { ok: false; error: string; needsLogin?: boolean; plan: string | null };

type Deps = { fetch?: typeof fetch; readCredential?: typeof defaultReadCredential; now?: () => number };

const cooldownUntil = new Map<string, number>();

const toTime = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};
const pct = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);

export function parseUsagePayload(payload: unknown): UsageRead & { ok: true } {
  const p = (payload ?? {}) as Record<string, any>;
  const windows: Partial<Record<"five_hour" | "seven_day", Win>> = {};
  const put = (name: "five_hour" | "seven_day", percent: number | null, reset: unknown) => {
    if (percent !== null) windows[name] = { usedPercent: percent, resetsAt: toTime(reset) };
  };
  if (Array.isArray(p.limits) && p.limits.length > 0) {
    for (const l of p.limits) {
      if (l?.kind === "session") put("five_hour", pct(l.percent), l.resets_at);
      if (l?.kind === "weekly_all") put("seven_day", pct(l.percent), l.resets_at);
    }
  } else {
    put("five_hour", pct(p.five_hour?.utilization), p.five_hour?.resets_at);
    put("seven_day", pct(p.seven_day?.utilization), p.seven_day?.resets_at);
  }
  return { ok: true, windows, plan: null };
}

export async function readAccountUsage(account: Account, deps: Deps = {}): Promise<UsageRead> {
  const now = (deps.now ?? Date.now)();
  const doFetch = deps.fetch ?? fetch;
  const cred = await (deps.readCredential ?? defaultReadCredential)(account.configDir);
  if (!cred) return { ok: false, needsLogin: true, plan: null, error: `No Claude login found for ${account.label}. Sign in again in the Claude Pool panel.` };
  const plan = cred.subscriptionType;
  if (cred.expiresAt !== null && cred.expiresAt > 0 && cred.expiresAt <= now) {
    return { ok: false, plan, error: `${account.label}: the token expired; Claude Code renews it on this account's next turn.` };
  }
  if ((cooldownUntil.get(account.id) ?? 0) > now) return { ok: false, plan, error: `${account.label}: Anthropic rate-limited usage reads; retrying soon.` };
  let res: Response;
  try {
    res = await doFetch(USAGE_URL, { headers: { authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": BETA }, signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    return { ok: false, plan, error: `${account.label}: ${err instanceof Error ? err.message : "request failed"}` };
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    cooldownUntil.set(account.id, now + (Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS));
    return { ok: false, plan, error: `${account.label}: Anthropic rate-limited usage reads; retrying soon.` };
  }
  if (res.status === 401) return { ok: false, needsLogin: true, plan, error: `${account.label}: session expired. Sign in again in the Claude Pool panel.` };
  if (res.status === 403) return { ok: false, plan, error: `${account.label}: this login cannot read usage (a setup-token login cannot).` };
  if (!res.ok) return { ok: false, plan, error: `${account.label}: API error ${res.status}` };
  try {
    return { ...parseUsagePayload(await res.json()), plan };
  } catch {
    return { ok: false, plan, error: `${account.label}: unexpected response from Anthropic` };
  }
}

export async function refreshAllUsage(dataDir: string = poolDataDir(), deps: Deps = {}): Promise<Record<string, UsageRead>> {
  const accounts = enabledAccounts(readAccounts(dataDir));
  const reads = await Promise.all(accounts.map((a) => readAccountUsage(a, deps)));
  const now = (deps.now ?? Date.now)();
  const out: Record<string, UsageRead> = {};
  updateState((s) => {
    accounts.forEach((a, i) => {
      const r = reads[i];
      out[a.id] = r;
      if (r.ok) {
        setNeedsLogin(s, a.id, false);
        for (const [name, w] of Object.entries(r.windows)) recordWindow(s, a.id, name as "five_hour" | "seven_day", { ...w!, updatedAt: now });
      } else if (r.needsLogin) {
        setNeedsLogin(s, a.id, true);
      }
    });
  }, dataDir, now);
  return out;
}

export function resetUsageCooldownsForTests(): void {
  cooldownUntil.clear();
}
```

- [ ] **Step 5: Implement `service/src/quota.ts`**

```ts
import type { QuotaProviderUsageData, QuotaProviderWindow } from "@openchamber/sdk";
import type { Account } from "../../shared/accounts.ts";
import { route } from "../../shared/router.ts";
import type { PoolState, WindowState } from "../../shared/state.ts";
import type { UsageRead } from "./usage.ts";

const FIVE_H = 5 * 3600;
const SEVEN_D = 7 * 24 * 3600;

const win = (w: WindowState | undefined, seconds: number, now: number, label?: string): QuotaProviderWindow | undefined => {
  if (!w) return undefined;
  const expired = w.resetsAt !== null && w.resetsAt <= now;
  return {
    usedPercent: expired ? 0 : w.usedPercent,
    windowSeconds: seconds,
    resetAt: expired ? null : w.resetsAt,
    ...(label ? { valueLabel: label } : {}),
  };
};

function windowsOf(st: PoolState["accounts"][string] | undefined, now: number, label?: string): Record<string, QuotaProviderWindow> {
  const out: Record<string, QuotaProviderWindow> = {};
  const h = win(st?.windows.five_hour, FIVE_H, now, label);
  const d = win(st?.windows.seven_day, SEVEN_D, now, label);
  if (h) out["5h"] = h;
  if (d) out["7d"] = d;
  return out;
}

function planSummary(reads: Record<string, UsageRead>, accounts: Account[]): string | null {
  const counts = new Map<string, number>();
  for (const a of accounts) {
    const plan = reads[a.id]?.plan ?? a.plan;
    if (!plan) continue;
    const name = plan.charAt(0).toUpperCase() + plan.slice(1);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts.size ? [...counts].map(([n, c]) => `${n} ×${c}`).join(", ") : null;
}

export function buildQuotaAnswer(input: {
  accounts: Account[];
  state: PoolState;
  threshold: number;
  now: number;
  reads: Record<string, UsageRead>;
}): QuotaProviderUsageData {
  const { accounts, state, threshold, now, reads } = input;
  if (accounts.length === 0) {
    return { ok: false, configured: true, error: "No Claude accounts yet. Add one in the Claude Pool panel.", usage: null };
  }
  const models: Record<string, { windows: Record<string, QuotaProviderWindow> }> = {};
  for (const a of accounts.slice(0, 64)) {
    const st = state.accounts[a.id];
    const windows = windowsOf(st, now);
    if (Object.keys(windows).length === 0) continue;
    const name = st?.needsLogin ? `${a.label} (sign in again)` : st?.limitedUntil && st.limitedUntil > now ? `${a.label} (limited)` : a.label;
    models[name] = { windows };
  }
  if (Object.keys(models).length === 0) {
    const firstError = Object.values(reads).find((r): r is UsageRead & { ok: false } => !r.ok)?.error ?? "No usage data yet.";
    return { ok: false, configured: true, error: firstError.slice(0, 2000), planLabel: planSummary(reads, accounts), usage: null };
  }
  const routed = route({ accounts, state, threshold, now });
  const top = routed.kind === "account" ? routed.account : accounts[0];
  return {
    ok: true,
    configured: true,
    planLabel: planSummary(reads, accounts),
    usage: { windows: windowsOf(state.accounts[top.id], now, top.label), models },
  };
}
```

If `QuotaProviderWindow` / `QuotaProviderUsageData` are not exported under these names, check the names with `grep -n "QuotaProvider" node_modules/@openchamber/sdk/dist/index.d.ts` (the example service imports these exact names).

- [ ] **Step 6: Register `POST /quota` in `service/src/main.ts`**

```ts
import { readQuotaProviderRequest } from "@openchamber/sdk";
import { enabledAccounts, readAccounts } from "../../shared/accounts.ts";
import { readState } from "../../shared/state.ts";
import { buildQuotaAnswer } from "./quota.ts";
import { refreshAllUsage } from "./usage.ts";

routes["POST /quota"] = async (r) => {
  if (!readQuotaProviderRequest(r.body)) return { status: 400, body: { error: "not a usage call this service understands" } };
  const reads = await refreshAllUsage();
  const file = readAccounts();
  const data = buildQuotaAnswer({ accounts: enabledAccounts(file), state: readState(), threshold: file.threshold, now: Date.now(), reads });
  return { status: 200, body: { ok: true, data } };
};
```

- [ ] **Step 7: Run the tests and rebuild**

Run: `bun test service && bun scripts/build.ts service`
Expected: PASS; `built service/main.js`

- [ ] **Step 8: Commit**

```bash
git add service
git commit -m "feat(service): per-account usage reads and the quota card answer"
```

---

### Task 15: Account API (list, import, rename, enable, reorder, remove, threshold)

**Files:**
- Create: `service/src/auth-status.ts`, `service/src/import.ts`, `service/src/accounts-api.ts`, `service/src/accounts-api.test.ts`
- Modify: `service/src/main.ts` (register the routes)

**Interfaces:**
- Consumes: Tasks 3–8, 14; `resolveClaudeCli`, `runCliProbe` from `plugin/src/executable-path.ts`; `buildClaudeCodeChildEnv` from `plugin/src/auth-env.ts`
- Produces:
  - `type AuthInfo = { loggedIn: boolean; email: string | null; plan: string | null }`
  - `readAuthStatus(configDir: string, deps?: { run?: (configDir: string) => Promise<string | null> }): Promise<AuthInfo>` (default dir runs without `CLAUDE_CONFIG_DIR`)
  - `findImportCandidates(deps: { home: string; existing: string[]; hasCredential: (dir: string) => Promise<boolean>; listHome?: () => string[] }): Promise<string[]>`
  - `accountRoutes(deps?: { dataDir?: string; authStatus?: typeof readAuthStatus; hasCredential?: (dir: string) => Promise<boolean>; home?: string }): Record<string, Route>`
  - JSON shapes:
    - `GET /api/accounts` → `{ accounts: AccountView[]; threshold: number; recoveredBackup: boolean; cliFound: boolean }` where `AccountView = Account & { state: AccountState | null; poolActive: boolean; canDeleteLogin: boolean }`
    - `GET /api/import-candidates` → `{ candidates: string[] }`
    - `POST /api/import` body `{ configDirs: string[] }` → `{ added: Account[]; skipped: { configDir: string; reason: string }[] }`
    - `PATCH /api/accounts/:id` body `{ label?: string; enabled?: boolean }` → `Account`
    - `POST /api/accounts/reorder` body `{ ids: string[] }` → `{ ok: true }`
    - `DELETE /api/accounts/:id?deleteLogin=1` → `{ ok: true; deletedLogin: boolean }`
    - `PUT /api/settings` body `{ threshold: number }` → `{ threshold: number }`

- [ ] **Step 1: Write the failing test** (`service/src/accounts-api.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccounts, updateAccounts } from "../../shared/accounts.ts";
import { accountRoutes } from "./accounts-api.ts";
import { findImportCandidates } from "./import.ts";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "pool-api-home-"));
  const dataDir = join(home, ".claude-pool");
  const routes = accountRoutes({
    dataDir, home,
    authStatus: async (dir) => ({ loggedIn: true, email: `${dir.split(/[\\/]/).pop()}@x.test`, plan: "pro" }),
    hasCredential: async () => true,
  });
  const call = async (key: string, body: unknown = undefined, query = "") =>
    routes[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(query), body: body === undefined ? "" : JSON.stringify(body) });
  return { home, dataDir, call };
};

describe("account api", () => {
  it("imports dirs with their email and plan, skipping duplicates", async () => {
    const { home, dataDir, call } = setup();
    const out: any = await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b"), join(home, ".claude")] });
    expect(out.status).toBe(200);
    expect(out.body.added.map((a: any) => a.email)).toEqual([".claude@x.test", ".claude-b@x.test"]);
    expect(out.body.skipped[0].reason).toMatch(/already/);
    expect(readAccounts(dataDir).accounts.map((a) => a.order)).toEqual([0, 1]);
  });

  it("refuses an import whose login is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "pool-api-home-"));
    const routes = accountRoutes({ dataDir: join(home, ".claude-pool"), home, authStatus: async () => ({ loggedIn: false, email: null, plan: null }), hasCredential: async () => false });
    const out: any = await routes["POST /api/import"]({ method: "POST", path: "/api/import", query: new URLSearchParams(), body: JSON.stringify({ configDirs: [join(home, ".claude")] }) });
    expect(out.body.added).toEqual([]);
    expect(out.body.skipped[0].reason).toMatch(/not signed in/);
  });

  it("renames, disables, reorders and sets the threshold", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    expect((await call("PATCH /api/accounts/:id", { label: "Work" }, `id=${a.id}`) as any).body.label).toBe("Work");
    await call("PATCH /api/accounts/:id", { enabled: false }, `id=${b.id}`);
    await call("POST /api/accounts/reorder", { ids: [b.id, a.id] });
    const after = readAccounts(dataDir);
    expect(after.accounts.find((x) => x.id === b.id)).toMatchObject({ enabled: false, order: 0 });
    expect((await call("PUT /api/settings", { threshold: 80 }) as any).body.threshold).toBe(80);
    expect((await call("PUT /api/settings", { threshold: 10 }) as any).status).toBe(400);
  });

  it("removes an account; deletes the login only for pool-created dirs", async () => {
    const { home, dataDir, call } = setup();
    const created = join(dataDir, "accounts", "abcdef");
    mkdirSync(created, { recursive: true });
    updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true });
      f.accounts.push({ id: "123456", label: "old", configDir: join(home, ".claude-b"), order: 1, enabled: true });
    }, dataDir);
    expect((await call("DELETE /api/accounts/:id", undefined, "id=abcdef&deleteLogin=1") as any).body.deletedLogin).toBe(true);
    expect(existsSync(created)).toBe(false);
    const kept: any = await call("DELETE /api/accounts/:id", undefined, "id=123456&deleteLogin=1");
    expect(kept.body.deletedLogin).toBe(false);
    expect(readAccounts(dataDir).accounts).toEqual([]);
  });

  it("lists accounts with state and canDeleteLogin", async () => {
    const { home, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude")] });
    const out: any = await call("GET /api/accounts");
    expect(out.body.accounts[0]).toMatchObject({ canDeleteLogin: false, poolActive: true });
    expect(out.body.threshold).toBe(90);
    expect(typeof out.body.cliFound).toBe("boolean");
  });

  it("import candidates: default dir and .claude-* dirs with a login, not already added, not the pool dir", async () => {
    const home = "/h";
    const c = await findImportCandidates({
      home, existing: [join(home, ".claude-x")],
      listHome: () => [".claude", ".claude-b", ".claude-x", ".claude-pool", ".claude.json", "other"],
      hasCredential: async (d) => !d.endsWith(".claude-nologin"),
    });
    expect(c).toEqual([join(home, ".claude"), join(home, ".claude-b")]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test service/src/accounts-api.test.ts`
Expected: FAIL, modules not found

- [ ] **Step 3: Implement `service/src/auth-status.ts`**

```ts
import { buildClaudeCodeChildEnv } from "../../plugin/src/auth-env.ts";
import { resolveClaudeCli, runCliProbe } from "../../plugin/src/executable-path.ts";
import { isDefaultConfigDir } from "../../shared/paths.ts";

export type AuthInfo = { loggedIn: boolean; email: string | null; plan: string | null };

export function envForDir(configDir: string): Record<string, string | undefined> {
  const env = buildClaudeCodeChildEnv(process.env);
  if (isDefaultConfigDir(configDir)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

async function defaultRun(configDir: string): Promise<string | null> {
  const env = envForDir(configDir);
  const bin = await resolveClaudeCli(env);
  if (!bin) return null;
  const result = await runCliProbe(bin, ["auth", "status", "--json"], { env, timeoutMs: 8000 });
  return result.stdout?.trim() || null;
}

export async function readAuthStatus(configDir: string, deps: { run?: (dir: string) => Promise<string | null> } = {}): Promise<AuthInfo> {
  const out = await (deps.run ?? defaultRun)(configDir);
  if (!out) return { loggedIn: false, email: null, plan: null };
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    return {
      loggedIn: j.loggedIn === true,
      email: typeof j.email === "string" ? j.email : null,
      plan: typeof j.subscriptionType === "string" ? j.subscriptionType : null,
    };
  } catch {
    return { loggedIn: false, email: null, plan: null };
  }
}
```

(Check the `runCliProbe` option names with `sed -n 48,60p plugin/src/executable-path.ts` and adapt `{ env, timeoutMs }` if needed.)

- [ ] **Step 4: Implement `service/src/import.ts`**

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeDir } from "../../shared/paths.ts";

export async function findImportCandidates(deps: {
  home: string;
  existing: string[];
  hasCredential: (dir: string) => Promise<boolean>;
  listHome?: () => string[];
}): Promise<string[]> {
  const list = deps.listHome ?? (() => readdirSync(deps.home).filter((n) => { try { return statSync(join(deps.home, n)).isDirectory(); } catch { return false; } }));
  const names = list().filter((n) => n === ".claude" || (n.startsWith(".claude-") && n !== ".claude-pool"));
  const taken = new Set(deps.existing.map((d) => normalizeDir(d, deps.home)));
  const out: string[] = [];
  for (const n of names.sort((a, b) => (a === ".claude" ? -1 : b === ".claude" ? 1 : a.localeCompare(b)))) {
    const dir = join(deps.home, n);
    if (taken.has(normalizeDir(dir, deps.home))) continue;
    if (await deps.hasCredential(dir)) out.push(dir);
  }
  return out;
}
```

- [ ] **Step 5: Implement `service/src/accounts-api.ts`**

```ts
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { MAX_THRESHOLD, MIN_THRESHOLD, newAccountId, readAccounts, updateAccounts, enabledAccounts, type Account } from "../../shared/accounts.ts";
import { readCredential } from "../../shared/creds.ts";
import { accountsFile, isInsidePoolAccounts, normalizeDir, poolDataDir } from "../../shared/paths.ts";
import { route } from "../../shared/router.ts";
import { readState } from "../../shared/state.ts";
import { existsSync } from "node:fs";
import type { Route } from "./http.ts";
import { readAuthStatus } from "./auth-status.ts";
import { findImportCandidates } from "./import.ts";
import { resolveClaudeCli } from "../../plugin/src/executable-path.ts";

const json = (r: { body: string }) => (r.body ? JSON.parse(r.body) : {});
const bad = (message: string) => ({ status: 400, body: { error: message } });

export function accountRoutes(deps: {
  dataDir?: string;
  home?: string;
  authStatus?: typeof readAuthStatus;
  hasCredential?: (dir: string) => Promise<boolean>;
  cliFound?: () => Promise<boolean>;
} = {}): Record<string, Route> {
  const cliFound = deps.cliFound ?? (async () => (await resolveClaudeCli(process.env)) !== null);
  const dataDir = deps.dataDir ?? poolDataDir();
  const home = deps.home ?? homedir();
  const authStatus = deps.authStatus ?? readAuthStatus;
  const hasCredential = deps.hasCredential ?? (async (dir: string) => (await readCredential(dir)) !== null);

  return {
    "GET /api/accounts": async () => {
      const found = await cliFound();
      const file = readAccounts(dataDir);
      const state = readState(dataDir);
      const choice = route({ accounts: enabledAccounts(file), state, threshold: file.threshold, now: Date.now() });
      const active = choice.kind === "account" ? choice.account.id : null;
      return {
        status: 200,
        body: {
          threshold: file.threshold,
          cliFound: found,
          recoveredBackup: existsSync(`${accountsFile(dataDir)}.bak`),
          accounts: [...file.accounts].sort((a, b) => a.order - b.order).map((a) => ({
            ...a,
            state: state.accounts[a.id] ?? null,
            poolActive: a.id === active,
            canDeleteLogin: isInsidePoolAccounts(a.configDir, dataDir),
          })),
        },
      };
    },

    "GET /api/import-candidates": async () => ({
      status: 200,
      body: { candidates: await findImportCandidates({ home, existing: readAccounts(dataDir).accounts.map((a) => a.configDir), hasCredential }) },
    }),

    "POST /api/import": async (r) => {
      const dirs: unknown = json(r).configDirs;
      if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string")) return bad("configDirs must be a list of folders");
      const added: Account[] = [];
      const skipped: { configDir: string; reason: string }[] = [];
      for (const raw of dirs as string[]) {
        const dir = normalizeDir(raw, home);
        const file = readAccounts(dataDir);
        if (file.accounts.some((a) => normalizeDir(a.configDir, home) === dir) || added.some((a) => a.configDir === dir)) {
          skipped.push({ configDir: dir, reason: "already in the pool" });
          continue;
        }
        const info = await authStatus(dir);
        if (!info.loggedIn) {
          skipped.push({ configDir: dir, reason: "not signed in to a Claude subscription" });
          continue;
        }
        const next = updateAccounts((f) => {
          const id = newAccountId(f.accounts.map((a) => a.id));
          const label = (info.email?.split("@")[0] ?? `account ${f.accounts.length + 1}`).slice(0, 40);
          f.accounts.push({ id, label, configDir: dir, order: f.accounts.length, enabled: true, ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) });
        }, dataDir);
        added.push(next.accounts.at(-1)!);
      }
      return { status: 200, body: { added, skipped } };
    },

    "PATCH /api/accounts/:id": (r) => {
      const id = r.query.get("id")!;
      const patch = json(r) as { label?: unknown; enabled?: unknown };
      let found: Account | undefined;
      try {
        updateAccounts((f) => {
          found = f.accounts.find((a) => a.id === id);
          if (!found) return;
          if (typeof patch.label === "string") found.label = patch.label.trim();
          if (typeof patch.enabled === "boolean") found.enabled = patch.enabled;
        }, dataDir);
      } catch (err) {
        return bad(err instanceof Error ? err.message : "invalid change");
      }
      return found ? { status: 200, body: found } : { status: 404, body: { error: "no such account" } };
    },

    "POST /api/accounts/reorder": (r) => {
      const ids: unknown = json(r).ids;
      if (!Array.isArray(ids)) return bad("ids must be a list");
      updateAccounts((f) => {
        const rank = new Map((ids as string[]).map((id, i) => [id, i]));
        f.accounts.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || a.order - b.order);
        f.accounts.forEach((a, i) => (a.order = i));
      }, dataDir);
      return { status: 200, body: { ok: true } };
    },

    "DELETE /api/accounts/:id": (r) => {
      const id = r.query.get("id")!;
      let removed: Account | undefined;
      updateAccounts((f) => {
        removed = f.accounts.find((a) => a.id === id);
        f.accounts = f.accounts.filter((a) => a.id !== id);
        f.accounts.forEach((a, i) => (a.order = i));
      }, dataDir);
      if (!removed) return { status: 404, body: { error: "no such account" } };
      let deletedLogin = false;
      if (r.query.get("deleteLogin") === "1" && isInsidePoolAccounts(removed.configDir, dataDir)) {
        rmSync(removed.configDir, { recursive: true, force: true });
        deletedLogin = true;
      }
      return { status: 200, body: { ok: true, deletedLogin } };
    },

    "PUT /api/settings": (r) => {
      const t = json(r).threshold;
      if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_THRESHOLD || t > MAX_THRESHOLD) return bad(`threshold must be ${MIN_THRESHOLD}..${MAX_THRESHOLD}`);
      const f = updateAccounts((file) => { file.threshold = t; }, dataDir);
      return { status: 200, body: { threshold: f.threshold } };
    },
  };
}
```

Note: deleting a pool-created dir on macOS leaves its Keychain item behind. Before `rmSync`, run `claude auth logout` in that dir, via `runCliProbe(bin, ["auth","logout"], { env: envForDir(dir) })` from `auth-status.ts`. Inject it through deps as `logout?: (dir: string) => Promise<void>` (default: that call; tests pass `async () => {}`).

- [ ] **Step 6: Register in `main.ts`**: `Object.assign(routes, accountRoutes());` with `import { accountRoutes } from "./accounts-api.ts";`

- [ ] **Step 7: Run the tests and rebuild**

Run: `bun test service && bun scripts/build.ts service`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add service
git commit -m "feat(service): account management API with import and safe removal"
```

---

### Task 16: In-app login per account

**Files:**
- Create: `service/src/login.ts`, `service/src/login.test.ts`
- Modify: `service/src/main.ts`

**Interfaces:**
- Consumes: `startClaudeCliLogin`, `submitClaudeCliLoginCode`, `cancelClaudeCliLogin`, `getClaudeCliLoginStatus` from `plugin/src/cli-login.ts` (`startClaudeCliLogin` accepts `{ env, cwd, binaryPath, spawnLogin, urlTimeoutMs }`); `envForDir`, `readAuthStatus` (Task 15); `newAccountDir`, `newAccountId`, `updateAccounts`, `setNeedsLogin`
- Produces:
  - `type LoginView = { state: "idle" } | { state: "awaiting-code"; url: string; accountId: string | null; label: string } | { state: "verifying" } | { state: "succeeded"; account: Account; duplicateOf: string | null } | { state: "failed"; message: string }`
  - `loginRoutes(deps?: { dataDir?: string; relay?: LoginRelay; authStatus?: typeof readAuthStatus }): Record<string, Route>` with:
    - `POST /api/login/start` body `{ label: string }` (new account) or `{ accountId: string }` (sign in again) → `LoginView`
    - `POST /api/login/code` body `{ code: string }` → `LoginView`
    - `POST /api/login/cancel` → `{ state: "idle" }`
    - `GET /api/login` → `LoginView`
  - `type LoginRelay = { start(env: Record<string, string | undefined>): Promise<{ state: "awaiting-code"; url: string } | { state: "failed"; message: string }>; submit(code: string): Promise<{ ok: true } | { ok: false; message: string }>; cancel(): void }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccounts, updateAccounts } from "../../shared/accounts.ts";
import { readState, setNeedsLogin, updateState } from "../../shared/state.ts";
import { loginRoutes, type LoginRelay } from "./login.ts";

function fakeRelay(result: "ok" | "bad") {
  const envs: Array<Record<string, string | undefined>> = [];
  const relay: LoginRelay = {
    start: async (env) => { envs.push(env); return { state: "awaiting-code", url: "https://claude.ai/oauth/authorize?x=1" }; },
    submit: async () => (result === "ok" ? { ok: true } : { ok: false, message: "Invalid code" }),
    cancel: () => {},
  };
  return { relay, envs };
}
const call = (routes: any, key: string, body?: unknown) =>
  routes[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(), body: body === undefined ? "" : JSON.stringify(body) });

describe("login", () => {
  it("new account: creates the dir, relays the URL, adds the account on success", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    const { relay, envs } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "me@x.test", plan: "max" }) });
    const started = (await call(routes, "POST /api/login/start", { label: "Second" })).body;
    expect(started).toMatchObject({ state: "awaiting-code", url: "https://claude.ai/oauth/authorize?x=1", label: "Second" });
    const dir = envs[0].CLAUDE_CONFIG_DIR!;
    expect(dir.startsWith(join(dataDir, "accounts"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const done = (await call(routes, "POST /api/login/code", { code: "abc#def" })).body;
    expect(done).toMatchObject({ state: "succeeded", duplicateOf: null });
    expect(readAccounts(dataDir).accounts[0]).toMatchObject({ label: "Second", email: "me@x.test", plan: "max", configDir: dir });
  });

  it("failed code keeps nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    const { relay, envs } = fakeRelay("bad");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: false, email: null, plan: null }) });
    await call(routes, "POST /api/login/start", { label: "X" });
    const out = (await call(routes, "POST /api/login/code", { code: "nope" })).body;
    expect(out).toMatchObject({ state: "failed" });
    expect(readAccounts(dataDir).accounts).toEqual([]);
    expect(existsSync(envs[0].CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  it("duplicate email is reported", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    updateAccounts((f) => f.accounts.push({ id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true, email: "me@x.test" }), dataDir);
    const { relay } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "me@x.test", plan: "pro" }) });
    await call(routes, "POST /api/login/start", { label: "dup" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "succeeded", duplicateOf: "aaaaaa" });
  });

  it("sign in again reuses the account dir and clears needsLogin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    updateAccounts((f) => f.accounts.push({ id: "bbbbbb", label: "b", configDir: join(dataDir, "accounts", "bbbbbb"), order: 0, enabled: true }), dataDir);
    updateState((s) => setNeedsLogin(s, "bbbbbb", true), dataDir);
    const { relay, envs } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "b@x.test", plan: "pro" }) });
    await call(routes, "POST /api/login/start", { accountId: "bbbbbb" });
    expect(envs[0].CLAUDE_CONFIG_DIR).toBe(join(dataDir, "accounts", "bbbbbb"));
    await call(routes, "POST /api/login/code", { code: "c" });
    expect(readState(dataDir).accounts.bbbbbb.needsLogin).toBe(false);
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test service/src/login.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `service/src/login.ts`**

```ts
import { mkdirSync, rmSync } from "node:fs";
import { cancelClaudeCliLogin, startClaudeCliLogin, submitClaudeCliLoginCode } from "../../plugin/src/cli-login.ts";
import { newAccountId, readAccounts, updateAccounts, type Account } from "../../shared/accounts.ts";
import { newAccountDir, poolDataDir } from "../../shared/paths.ts";
import { setNeedsLogin, updateState } from "../../shared/state.ts";
import { envForDir, readAuthStatus } from "./auth-status.ts";
import type { Route } from "./http.ts";

export type LoginRelay = {
  start(env: Record<string, string | undefined>): Promise<{ state: "awaiting-code"; url: string } | { state: "failed"; message: string }>;
  submit(code: string): Promise<{ ok: true } | { ok: false; message: string }>;
  cancel(): void;
};

export type LoginView =
  | { state: "idle" }
  | { state: "awaiting-code"; url: string; accountId: string | null; label: string }
  | { state: "verifying" }
  | { state: "succeeded"; account: Account; duplicateOf: string | null }
  | { state: "failed"; message: string };

const cliRelay: LoginRelay = {
  start: async (env) => {
    const r = await startClaudeCliLogin({ env });
    return r.state === "awaiting-code" ? r : { state: "failed", message: r.message };
  },
  submit: (code) => submitClaudeCliLoginCode(code),
  cancel: () => cancelClaudeCliLogin(),
};

type Pending = { accountId: string | null; id: string; label: string; dir: string; created: boolean; url: string };

export function loginRoutes(deps: { dataDir?: string; relay?: LoginRelay; authStatus?: typeof readAuthStatus } = {}): Record<string, Route> {
  const dataDir = deps.dataDir ?? poolDataDir();
  const relay = deps.relay ?? cliRelay;
  const authStatus = deps.authStatus ?? readAuthStatus;
  let pending: Pending | null = null;
  let view: LoginView = { state: "idle" };

  const discard = () => {
    if (pending?.created) rmSync(pending.dir, { recursive: true, force: true });
    pending = null;
  };
  const body = (r: { body: string }) => (r.body ? JSON.parse(r.body) : {});

  return {
    "GET /api/login": () => ({ status: 200, body: view }),

    "POST /api/login/start": async (r) => {
      const { label, accountId } = body(r) as { label?: string; accountId?: string };
      relay.cancel();
      discard();
      if (accountId) {
        const acc = readAccounts(dataDir).accounts.find((a) => a.id === accountId);
        if (!acc) return { status: 404, body: { error: "no such account" } };
        pending = { accountId, id: acc.id, label: acc.label, dir: acc.configDir, created: false, url: "" };
      } else {
        const name = (label ?? "").trim();
        if (!name || name.length > 40) return { status: 400, body: { error: "label must be 1..40 characters" } };
        const id = newAccountId(readAccounts(dataDir).accounts.map((a) => a.id));
        const dir = newAccountDir(id, dataDir);
        mkdirSync(dir, { recursive: true });
        pending = { accountId: null, id, label: name, dir, created: true, url: "" };
      }
      const started = await relay.start(envForDir(pending.dir));
      if (started.state === "failed") {
        discard();
        view = { state: "failed", message: started.message };
      } else {
        pending.url = started.url;
        view = { state: "awaiting-code", url: started.url, accountId: pending.accountId, label: pending.label };
      }
      return { status: 200, body: view };
    },

    "POST /api/login/code": async (r) => {
      const code = String(body(r).code ?? "").trim();
      if (!pending) return { status: 409, body: { error: "no sign-in in progress" } };
      if (!code) return { status: 400, body: { error: "paste the code from the Claude page" } };
      const p = pending;
      view = { state: "verifying" };
      const submitted = await relay.submit(code);
      const info = await authStatus(p.dir);
      if (!submitted.ok && !info.loggedIn) {
        discard();
        view = { state: "failed", message: submitted.message || "Claude Code did not accept the code." };
        return { status: 200, body: view };
      }
      const existing = readAccounts(dataDir).accounts;
      const duplicateOf = info.email ? existing.find((a) => a.email === info.email && a.id !== p.id)?.id ?? null : null;
      const file = updateAccounts((f) => {
        const acc = f.accounts.find((a) => a.id === p.id);
        if (acc) {
          if (info.email) acc.email = info.email;
          if (info.plan) acc.plan = info.plan;
        } else {
          f.accounts.push({ id: p.id, label: p.label, configDir: p.dir, order: f.accounts.length, enabled: true, ...(info.email ? { email: info.email } : {}), ...(info.plan ? { plan: info.plan } : {}) });
        }
      }, dataDir);
      updateState((s) => setNeedsLogin(s, p.id, false), dataDir);
      pending = null;
      view = { state: "succeeded", account: file.accounts.find((a) => a.id === p.id)!, duplicateOf };
      return { status: 200, body: view };
    },

    "POST /api/login/cancel": () => {
      relay.cancel();
      discard();
      view = { state: "idle" };
      return { status: 200, body: view };
    },
  };
}
```

- [ ] **Step 4: Register in `main.ts`**: `Object.assign(routes, loginRoutes());`

- [ ] **Step 5: Run the tests and rebuild**

Run: `bun test service && bun scripts/build.ts service`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add service
git commit -m "feat(service): in-app Claude sign-in per account"
```

---

### Task 17: Panel UI

**Files:**
- Create: `ui/shared/api.ts`, `ui/shared/format.ts`, `ui/shared/format.test.ts`, `ui/panel/index.html`, `ui/panel/main.ts`
- Create (built): `ui/panel/main.js`

**Interfaces:**
- Consumes: the service JSON shapes from Tasks 15–16; `connectHost`, `host.serviceRequest`, `host.openUrl`, `host.onReady` from `@openchamber/sdk`; `applyHostReady`, `mountButton`, `mountBadge`, `mountProgress`, `mountTextField`, `mountSwitch`, `mountBanner`, `mountEmpty` from `@openchamber/sdk/ui`
- Produces:
  - `api(host)` → `{ list(), candidates(), import(dirs), patch(id, p), reorder(ids), remove(id, deleteLogin), setThreshold(t), loginStart(p), loginCode(code), loginCancel(), login() }`
  - `format.ts`: `statusBadge(view: AccountView, now: number): { label: string; tone: "success" | "warning" | "error" | "neutral" }`, `windowPercent(st, name, now): number`, `resetText(ms: number | null, now: number): string`

- [ ] **Step 1: Write the failing format test** (`ui/shared/format.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { resetText, statusBadge, windowPercent } from "./format.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const base = { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true, poolActive: false, canDeleteLogin: false };

describe("format", () => {
  it("badges in priority order", () => {
    expect(statusBadge({ ...base, enabled: false, state: null }, NOW)).toEqual({ label: "Disabled", tone: "neutral" });
    expect(statusBadge({ ...base, state: { windows: {}, limitedUntil: null, needsLogin: true } }, NOW)).toEqual({ label: "Sign in again", tone: "error" });
    expect(statusBadge({ ...base, state: { windows: {}, limitedUntil: NOW + 90 * 60_000, needsLogin: false } }, NOW)).toEqual({ label: "Limited · 1h 30m", tone: "warning" });
    expect(statusBadge({ ...base, poolActive: true, state: null }, NOW)).toEqual({ label: "Active in pool", tone: "success" });
    expect(statusBadge({ ...base, state: null }, NOW)).toEqual({ label: "Ready", tone: "neutral" });
  });
  it("percent ignores expired windows", () => {
    const st = { windows: { five_hour: { usedPercent: 70, resetsAt: NOW - 1, updatedAt: 0 }, seven_day: { usedPercent: 40, resetsAt: NOW + 1, updatedAt: 0 } }, limitedUntil: null, needsLogin: false };
    expect(windowPercent(st, "five_hour", NOW)).toBe(0);
    expect(windowPercent(st, "seven_day", NOW)).toBe(40);
    expect(windowPercent(null, "seven_day", NOW)).toBe(0);
  });
  it("reset text", () => {
    expect(resetText(null, NOW)).toBe("");
    expect(resetText(NOW + 5 * 60_000, NOW)).toBe("resets in 5m");
    expect(resetText(NOW + 26 * 3600_000, NOW)).toBe("resets in 1d 2h");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test ui/shared/format.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement `ui/shared/format.ts`**

```ts
import type { Account } from "../../shared/accounts.ts";
import type { AccountState, WindowName } from "../../shared/state.ts";

export type AccountView = Account & { state: AccountState | null; poolActive: boolean; canDeleteLogin: boolean };

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return `${min}m`;
}

export function statusBadge(v: AccountView, now: number): { label: string; tone: "success" | "warning" | "error" | "neutral" } {
  if (!v.enabled) return { label: "Disabled", tone: "neutral" };
  if (v.state?.needsLogin) return { label: "Sign in again", tone: "error" };
  if (v.state?.limitedUntil && v.state.limitedUntil > now) return { label: `Limited · ${duration(v.state.limitedUntil - now)}`, tone: "warning" };
  if (v.poolActive) return { label: "Active in pool", tone: "success" };
  return { label: "Ready", tone: "neutral" };
}

export function windowPercent(st: AccountState | null, name: WindowName, now: number): number {
  const w = st?.windows[name];
  if (!w || (w.resetsAt !== null && w.resetsAt <= now)) return 0;
  return w.usedPercent;
}

export function resetText(resetsAt: number | null, now: number): string {
  return resetsAt === null || resetsAt <= now ? "" : `resets in ${duration(resetsAt - now)}`;
}
```

- [ ] **Step 4: Implement `ui/shared/api.ts`**

```ts
import type { AccountView } from "./format.ts";

type Host = { serviceRequest(r: { method: string; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> };

async function call<T>(host: Host, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const res = await host.serviceRequest({ method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const parsed = res.body ? JSON.parse(res.body) : {};
  if (res.status >= 400) throw new Error(parsed.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

export const api = (host: Host) => ({
  list: () => call<{ accounts: AccountView[]; threshold: number; recoveredBackup: boolean; cliFound: boolean }>(host, "GET", "/api/accounts"),
  candidates: () => call<{ candidates: string[] }>(host, "GET", "/api/import-candidates"),
  import: (configDirs: string[]) => call<{ added: unknown[]; skipped: { configDir: string; reason: string }[] }>(host, "POST", "/api/import", { configDirs }),
  patch: (id: string, p: { label?: string; enabled?: boolean }) => call(host, "PATCH", `/api/accounts/${id}`, p),
  reorder: (ids: string[]) => call(host, "POST", "/api/accounts/reorder", { ids }),
  remove: (id: string, deleteLogin: boolean) => call<{ deletedLogin: boolean }>(host, "DELETE", `/api/accounts/${id}`, undefined, deleteLogin ? { deleteLogin: "1" } : undefined),
  setThreshold: (threshold: number) => call(host, "PUT", "/api/settings", { threshold }),
  loginStart: (p: { label: string } | { accountId: string }) => call<any>(host, "POST", "/api/login/start", p),
  loginCode: (code: string) => call<any>(host, "POST", "/api/login/code", { code }),
  loginCancel: () => call(host, "POST", "/api/login/cancel"),
  login: () => call<any>(host, "GET", "/api/login"),
});
```

- [ ] **Step 5: Write `ui/panel/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Claude Pool</title>
    <style>
      html, body { margin: 0; }
      #root { padding: 12px; display: flex; flex-direction: column; gap: 12px; font: inherit; }
      .acct { border-radius: var(--radius, 8px); padding: 10px; background: var(--muted, rgba(127,127,127,.08)); display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .grow { flex: 1; min-width: 0; }
      .muted { opacity: .7; font-size: .9em; }
      .bars { display: grid; grid-template-columns: 2.2em 1fr auto; gap: 4px 8px; align-items: center; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="main.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Implement `ui/panel/main.ts`**

```ts
import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountBadge, mountBanner, mountButton, mountEmpty, mountProgress, mountSwitch, mountTextField } from "@openchamber/sdk/ui";
import { api } from "../shared/api.ts";
import { resetText, statusBadge, windowPercent, type AccountView } from "../shared/format.ts";

const host = connectHost();
const root = document.querySelector("#root")!;
const client = api(host as any);
let mounted = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

async function render(): Promise<void> {
  root.replaceChildren();
  let data: Awaited<ReturnType<typeof client.list>>;
  try {
    data = await client.list();
  } catch (err) {
    mountBanner(root, { tone: "error", title: "The Claude Pool service did not answer", body: String((err as Error).message) });
    return;
  }
  const now = Date.now();
  if (!data.cliFound) {
    mountBanner(root, { tone: "error", title: "Claude Code CLI not found", body: "Install it with `npm install -g @anthropic-ai/claude-code` (or the native installer), make sure `claude` is on PATH, then reopen this panel. Turns fail until it is installed." });
  }
  if (data.recoveredBackup) {
    mountBanner(root, { tone: "warning", title: "accounts.json was unreadable", body: "It was moved to accounts.json.bak in ~/.claude-pool. Re-add your accounts or restore the file." });
  }

  const head = el("div", "row");
  head.append(el("strong", "grow", "Claude accounts"));
  mountButton(head, { label: "Add account", onClick: () => void addFlow() });
  mountButton(head, { label: "Import", variant: "outline", onClick: () => void importFlow() });
  root.append(head);

  if (data.accounts.length === 0) {
    mountEmpty(root, { title: "No accounts yet", description: "Add a Claude account, or import the ones Claude Code is already signed in to." } as any);
  }

  data.accounts.forEach((a, i) => root.append(accountCard(a, i, data.accounts, now)));

  const settings = el("div", "acct");
  let threshold = String(data.threshold);
  const field = mountTextField(settings, {
    label: "Switch accounts at (% of the 5h or weekly window)",
    value: threshold,
    helper: "50–100. The pool moves a conversation to another account once its account passes this.",
    onChange: (v) => { threshold = v; field.update({ value: v }); },
  });
  mountButton(settings, { label: "Save", variant: "secondary", size: "sm", onClick: () => void client.setThreshold(Number(threshold)).then(render, (e) => field.update({ error: e.message })) });
  root.append(settings);
}

function accountCard(a: AccountView, index: number, all: AccountView[], now: number): HTMLElement {
  const card = el("div", "acct");
  const top = el("div", "row");
  const name = el("div", "grow");
  name.append(el("strong", "", a.label), el("div", "muted", [a.email, a.plan && a.plan.toUpperCase()].filter(Boolean).join(" · ")));
  top.append(name);
  mountBadge(top, statusBadge(a, now));
  card.append(top);

  const bars = el("div", "bars");
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    bars.append(el("span", "muted", label));
    const cell = el("div");
    const pct = windowPercent(a.state, key, now);
    mountProgress(cell, { value: pct, tone: pct >= 90 ? "error" : pct >= 70 ? "warning" : "primary" });
    bars.append(cell, el("span", "muted", `${Math.round(pct)}% ${resetText(a.state?.windows[key]?.resetsAt ?? null, now)}`));
  }
  card.append(bars);

  const actions = el("div", "row");
  mountSwitch(actions, { label: "In pool", checked: a.enabled, onChange: (v) => void client.patch(a.id, { enabled: v }).then(render) });
  if (a.state?.needsLogin) mountButton(actions, { label: "Sign in again", size: "sm", onClick: () => void loginFlow({ accountId: a.id }) });
  mountButton(actions, { label: "Rename", variant: "ghost", size: "sm", onClick: () => {
    const label = prompt("New name", a.label);
    if (label) void client.patch(a.id, { label }).then(render);
  } });
  if (index > 0) mountButton(actions, { label: "↑", variant: "ghost", size: "xs", onClick: () => {
    const ids = all.map((x) => x.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    void client.reorder(ids).then(render);
  } });
  mountButton(actions, { label: "Remove", variant: "destructive", size: "sm", onClick: () => {
    if (!confirm(`Remove ${a.label} from the pool?`)) return;
    const deleteLogin = a.canDeleteLogin && confirm("Also sign this account out and delete its Claude Pool folder?");
    void client.remove(a.id, deleteLogin).then(render);
  } });
  card.append(actions);
  return card;
}

async function addFlow(): Promise<void> {
  const label = prompt("Name for the new account (e.g. work, personal)");
  if (label) await loginFlow({ label });
}

async function loginFlow(start: { label: string } | { accountId: string }): Promise<void> {
  root.replaceChildren();
  const box = el("div", "acct");
  root.append(box);
  const view = await client.loginStart(start).catch((e: Error) => ({ state: "failed", message: e.message }));
  if (view.state !== "awaiting-code") {
    mountBanner(box, { tone: "error", title: "Could not start the sign-in", body: view.message, action: { label: "Back", onClick: () => void render() } });
    return;
  }
  await host.openUrl(view.url);
  box.append(el("div", "", "Sign in on the Claude page that opened, then paste the code it shows."));
  const link = el("div", "row");
  mountButton(link, { label: "Open the sign-in page again", variant: "ghost", size: "sm", onClick: () => void host.openUrl(view.url) });
  box.append(link);
  let code = "";
  const field = mountTextField(box, { label: "Code", value: "", mono: true, onChange: (v) => { code = v; field.update({ value: v }); } });
  const row = el("div", "row");
  const submit = mountButton(row, { label: "Finish sign-in", onClick: () => {
    submit.update({ loading: true });
    void client.loginCode(code).then((done: any) => {
      if (done.state === "succeeded") {
        if (done.duplicateOf) alert("This Claude account is already in the pool under another name. Both entries use the same subscription.");
        void render();
      } else {
        submit.update({ loading: false });
        field.update({ error: done.message ?? "The code was not accepted." });
      }
    });
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", onClick: () => void client.loginCancel().then(render) });
  box.append(row);
}

async function importFlow(): Promise<void> {
  const { candidates } = await client.candidates();
  if (candidates.length === 0) {
    alert("No other Claude Code logins were found in your home folder.");
    return;
  }
  const chosen = candidates.filter((dir) => confirm(`Import the Claude Code login in\n${dir}?`));
  if (chosen.length === 0) return;
  const out = await client.import(chosen);
  if (out.skipped.length) alert(out.skipped.map((s) => `${s.configDir}: ${s.reason}`).join("\n"));
  await render();
}

host.onReady((ctx: any) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  void render();
});
```

`prompt`/`confirm`/`alert` work inside the sandboxed panel frame only if the host allows modals. If the first manual check (Task 20) shows they are blocked, replace them with inline `mountTextField` rows and two-button confirm rows. Keep it a small follow-up commit; the API calls stay the same.

- [ ] **Step 7: Run the test, build, and run the guest check**

Run: `bun test ui && bun scripts/build.ts ui && bunx openchamber-guest-check .`
Expected: PASS, `built ui/panel/main.js`, check OK.

- [ ] **Step 8: Commit**

```bash
git add ui
git commit -m "feat(ui): Claude Pool panel with accounts, sign-in and import"
```

---

### Task 18: Work Status section

**Files:**
- Create: `ui/status/index.html`, `ui/status/main.ts`
- Create (built): `ui/status/main.js`

**Interfaces:**
- Consumes: `api(host).list()` (Task 17), `windowPercent`, `statusBadge` (Task 17), `host.setHeight`

- [ ] **Step 1: Write `ui/status/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; }
      #root { padding: 6px 8px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 8px; align-items: center; font-size: .9em; }
      .active { font-weight: 600; }
      .muted { opacity: .7; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="main.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `ui/status/main.ts`**

```ts
import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountProgress } from "@openchamber/sdk/ui";
import { api } from "../shared/api.ts";
import { statusBadge, windowPercent } from "../shared/format.ts";

const host = connectHost();
const root = document.querySelector("#root")!;
const client = api(host as any);
let mounted = false;

async function render() {
  root.replaceChildren();
  try {
    const { accounts } = await client.list();
    const now = Date.now();
    if (accounts.length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "No accounts. Open the Claude Pool panel to add one.";
      empty.style.gridColumn = "1 / -1";
      root.append(empty);
    }
    for (const a of accounts.filter((x) => x.enabled)) {
      const name = document.createElement("span");
      name.textContent = (a.poolActive ? "● " : "") + a.label;
      if (a.poolActive) name.className = "active";
      const bar = document.createElement("div");
      const pct = windowPercent(a.state, "five_hour", now);
      mountProgress(bar, { value: pct, tone: pct >= 90 ? "error" : pct >= 70 ? "warning" : "primary" });
      const note = document.createElement("span");
      note.className = "muted";
      const badge = statusBadge(a, now);
      note.textContent = badge.tone === "neutral" || badge.tone === "success" ? `${Math.round(pct)}%` : badge.label;
      root.append(name, bar, note);
    }
  } catch {
    root.textContent = "Claude Pool service unavailable.";
  }
  await host.setHeight(Math.ceil(document.documentElement.scrollHeight));
}

host.onReady((ctx: any) => {
  applyHostReady(ctx, document.documentElement);
  if (!mounted) {
    mounted = true;
    void render();
  }
});
```

(A refresh happens each time the section frame loads or is expanded; there is no interval timer, per the no-polling constraint.)

- [ ] **Step 3: Build and check**

Run: `bun scripts/build.ts ui && bunx openchamber-guest-check .`
Expected: `built ui/status/main.js`, check OK.

- [ ] **Step 4: Commit**

```bash
git add ui
git commit -m "feat(ui): Work Status section with per-account 5h bars"
```

---

### Task 19: CI on macOS and Windows, bundle freshness

**Files:**
- Create: `scripts/check-bundles.ts`, `.github/workflows/ci.yml`

- [ ] **Step 1: Write `scripts/check-bundles.ts`**

```ts
/** Fails when a committed bundle differs from a fresh build. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const files = ["plugin/index.js", "service/main.js", "ui/panel/main.js", "ui/status/main.js"];
const before = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
const proc = Bun.spawnSync([process.execPath, join(root, "scripts/build.ts"), "all"], { stdout: "inherit", stderr: "inherit" });
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
const stale = files.filter((f) => readFileSync(join(root, f), "utf8") !== before.get(f));
if (stale.length) {
  console.error(`Stale bundles (run bun run build and commit): ${stale.join(", ")}`);
  process.exit(1);
}
console.log("bundles are fresh");
```

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run check
      - run: bun run test:shared
      - run: bun run test:plugin
      - run: bun plugin/test/bundle-load-regression.ts
      - run: bun run check:bundles
      - run: bunx openchamber-guest-check .
```

- [ ] **Step 3: Run the same commands locally**

Run: `bun run check && bun run test && bun plugin/test/bundle-load-regression.ts && bun run check:bundles && bunx openchamber-guest-check .`
Expected: all green, `bundles are fresh`.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-bundles.ts .github/workflows/ci.yml bun.lock
git commit -m "ci: macOS and Windows matrix with bundle freshness and guest check"
```

---

### Task 20: Docs and the manual end-to-end check (release gate)

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `docs/e2e-checklist.md`
- Modify: `plugin/README.md` (one line at the top: "This folder is the Claude Pool fork of opencode-claude; see the root README.")

- [ ] **Step 1: Write `README.md`** with these sections, in this order:
  1. What it is (one paragraph) and a screenshot placeholder line `![Claude Pool panel](docs/panel.png)` (the image is added after the manual check).
  2. Requirements: OpenChamber ≥ 2.7.0 (desktop or web), Claude Code CLI on PATH, one or more Claude Pro/Max accounts.
  3. Install: Settings → Extensions → Add → `https://github.com/bogdanivan12/openchamber-claude-pool.git`; approve "Run a local service", "Add a plugin to OpenCode", "Reports usage".
  4. Add accounts: Import existing logins / Add account (in-app sign-in).
  5. Using it: pick `Claude Pool` models for automatic failover, or `Claude · <name>` for a fixed account; the threshold setting; what happens at a limit (rerun, 429 countdown); first turn after a switch has a cold cache.
  6. Usage card: one card, the pool's current account on top, a group per account. Optionally hide the built-in Claude card in Settings → Usage.
  7. How it works (short): one `CLAUDE_CONFIG_DIR` per account; files in `~/.claude-pool`; nothing runs in the background.
  8. **Use at your own risk**: "Anthropic's terms say plan limits assume ordinary, individual use. There are public reports of accounts suspended for automatic rotation across several subscriptions. Claude Pool does not hide what it does. Decide whether the pool fits how you use your accounts; per-account providers work without it."
  9. Platform notes: macOS reads the Keychain item per account. Windows reads `<dir>\.credentials.json`. Windows end-to-end with real accounts is not yet verified by the author.
  10. Credits: built on `openchamber/opencode-claude` (MIT).

- [ ] **Step 2: Write `CHANGELOG.md`** with `## 0.1.0 – unreleased` listing the features from this plan.

- [ ] **Step 3: Write `docs/e2e-checklist.md`** (the user runs it on their Mac; each item has Pass/Fail):

```markdown
# Manual end-to-end check (macOS, two real accounts)

Prep: OpenChamber running; in Settings → Extensions → Add, the absolute path of this repo folder.

1. Approve the permissions. Settings → Plugins lists `claude-pool` as active within seconds.
2. Panel → Import: `~/.claude` and `~/.claude-b` are offered; import both. Each shows its email and plan.
3. Model picker shows `Claude Pool` and `Claude · <name>` for each account.
4. Send one message with `Claude · <account 2>`. On claude.ai (account 2), usage rose; account 1 unchanged.
5. Settings → Usage: the Claude Pool card shows a group per account; the top windows carry the pool account's name.
6. Work Status shows the Claude Pool section with a line per account.
7. Panel → threshold to 50 and send with `Claude Pool` until the active account passes 50% (or temporarily set threshold to a value below its current 5h usage). The next turn runs on the other account, and the conversation continues with its context.
8. Panel → Add account → sign in with a third account (or the same as 2 to see the duplicate warning), finish with the code.
9. Panel → disable an account: its provider leaves the model picker within seconds.
10. Remove the third account with "delete login": its folder in ~/.claude-pool/accounts is gone.
11. Quit OpenChamber: no `claude-pool` service process remains (`ps aux | grep service/main.js`).
```

- [ ] **Step 4: Run the full check one more time**

Run: `bun run check && bun run test && bun run check:bundles && bunx openchamber-guest-check .`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/e2e-checklist.md plugin/README.md
git commit -m "docs: README with risk statement, changelog and manual e2e checklist"
```

- [ ] **Step 6: STOP: release gate.** Report to the user:
  - Ask them to run `docs/e2e-checklist.md` and give the results.
  - Ask for approval to create the public GitHub repo `bogdanivan12/openchamber-claude-pool`, push, and tag `v0.1.0`.
  - Ask separately for approval to email the catalog submission.
  
  Do NOT push, tag or email without their explicit yes.
