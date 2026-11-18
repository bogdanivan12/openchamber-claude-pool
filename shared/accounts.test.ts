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
