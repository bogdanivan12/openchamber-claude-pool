import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THRESHOLD, emptyAccounts, enabledAccounts, findByConfigDir,
  newAccountId, readAccounts, readWithRetry, updateAccounts,
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

  it("quarantines corrupt files without overwriting an earlier backup", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = dir();
      writeFileSync(join(d, "accounts.json"), "{bad1");
      expect(readAccounts(d).accounts).toEqual([]);
      expect(readFileSync(join(d, "accounts.json.bak"), "utf8")).toBe("{bad1");
      writeFileSync(join(d, "accounts.json"), "{bad2");
      expect(readAccounts(d).accounts).toEqual([]);
      expect(readFileSync(join(d, "accounts.json.bak"), "utf8")).toBe("{bad1");
      const extra = readdirSync(d).filter((n) => n.startsWith("accounts.json.bak."));
      expect(extra.length).toBe(1);
      expect(readFileSync(join(d, extra[0]), "utf8")).toBe("{bad2");
    } finally { warn.mockRestore(); }
  });

  it("schema-invalid files count as corrupt", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = dir();
      writeFileSync(join(d, "accounts.json"), JSON.stringify({ version: 2 }));
      expect(readAccounts(d).accounts).toEqual([]);
      expect(existsSync(join(d, "accounts.json.bak"))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it("I/O errors are not corruption: file untouched, update throws", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const d = dir();
      mkdirSync(join(d, "accounts.json"));
      expect(readAccounts(d).accounts).toEqual([]);
      expect(() => updateAccounts((f) => { f.threshold = 80; }, d)).toThrow();
      expect(existsSync(join(d, "accounts.json.bak"))).toBe(false);
      expect(readdirSync(d).some((n) => n.startsWith("accounts.json.bak"))).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it("a valid file is never renamed", () => {
    const d = dir();
    updateAccounts((f) => { f.threshold = 80; }, d);
    expect(readAccounts(d).threshold).toBe(80);
    expect(readdirSync(d).some((n) => n.includes(".bak"))).toBe(false);
  });

  it("update rejects empty, relative and duplicate config dirs and writes nothing", () => {
    const d = dir();
    for (const configDir of ["", "   ", "relative/dir"]) {
      expect(() => updateAccounts((f) => {
        f.accounts.push({ id: "abcdef", label: "x", configDir, order: 0, enabled: true });
      }, d)).toThrow();
    }
    expect(() => updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "x", configDir: "/x", order: 0, enabled: true });
      f.accounts.push({ id: "abcdea", label: "y", configDir: "/x/", order: 1, enabled: true });
    }, d)).toThrow();
    expect(existsSync(join(d, "accounts.json"))).toBe(false);
    updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "x", configDir: "~/.claude-t", order: 0, enabled: true });
    }, d);
    expect(readAccounts(d).accounts[0].configDir).toBe(join(homedir(), ".claude-t"));
  });

  it("readWithRetry retries transient I/O errors and then succeeds", () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = readWithRetry(() => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return "ok";
    }, (ms) => sleeps.push(ms));
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([15, 30]);
  });

  it("readWithRetry gives up after 3 attempts and never retries other errors", () => {
    let calls = 0;
    expect(() => readWithRetry(() => { calls++; throw Object.assign(new Error("perm"), { code: "EPERM" }); }, () => {})).toThrow("perm");
    expect(calls).toBe(4);
    calls = 0;
    expect(() => readWithRetry(() => { calls++; throw Object.assign(new Error("x"), { code: "EISDIR" }); }, () => {})).toThrow("x");
    expect(calls).toBe(1);
  });

  it("findByConfigDir compares case-insensitively on win32 only", () => {
    const file = { ...emptyAccounts(), accounts: [{ id: "a1b2c3", label: "a", configDir: join(homedir(), ".Claude-X"), order: 0, enabled: true }] };
    const other = join(homedir(), ".claude-x");
    expect(findByConfigDir(file, other, "win32")?.id).toBe("a1b2c3");
    expect(findByConfigDir(file, other, "linux")).toBeUndefined();
  });

  it("the duplicate configDir check follows the platform's case rules", () => {
    const d = dir();
    const run = () => updateAccounts((f) => {
      f.accounts.push({ id: "a1b2c3", label: "a", configDir: join(d, "X"), order: 0, enabled: true });
      f.accounts.push({ id: "d4e5f6", label: "b", configDir: join(d, "x"), order: 1, enabled: true });
    }, d);
    if (process.platform === "win32") expect(run).toThrow("duplicate configDir");
    else expect(run).not.toThrow();
  });
});
