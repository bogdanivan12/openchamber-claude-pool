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
