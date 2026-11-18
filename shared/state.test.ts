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
