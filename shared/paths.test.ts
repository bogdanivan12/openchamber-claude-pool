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
