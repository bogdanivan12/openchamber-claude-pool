import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_WINDOW_MS, CONVERSATION_TTL_MS, activeConversations, bindConversation, touchConversation, emptyState, markLimited, readState, recordWindow,
  setNeedsLogin, fractionToPercent, clampPercent, updateState, windowNameFromRateLimitType,
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
  });

  it("fractionToPercent scales the SDK 0..1 utilization", () => {
    expect(fractionToPercent(0.42)).toBe(42);
    expect(fractionToPercent(1)).toBe(100);
    expect(fractionToPercent(0)).toBe(0);
    expect(fractionToPercent(1.5)).toBe(100);
  });

  it("clampPercent keeps 0..100 values as they are", () => {
    expect(clampPercent(1)).toBe(1);
    expect(clampPercent(0.5)).toBe(0.5);
    expect(clampPercent(73)).toBe(73);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(NaN)).toBe(0);
  });

  it("recordWindow clamps out-of-range and ignores non-finite samples", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 150, resetsAt: 1, updatedAt: 1 });
    expect(s.accounts.aaaaaa.windows.five_hour?.usedPercent).toBe(100);
    const t = emptyState();
    recordWindow(t, "bbbbbb", "five_hour", { usedPercent: NaN, resetsAt: 1, updatedAt: 1 });
    expect(t.accounts.bbbbbb?.windows.five_hour).toBeUndefined();
  });
});

describe("conversation activity", () => {
  it("counts conversations per account that made a request within the window, and touch updates only known ones", () => {
    const s = emptyState();
    bindConversation(s, "a", "aaaaaa", 1000);
    bindConversation(s, "b", "aaaaaa", 1000);
    bindConversation(s, "c", "bbbbbb", 1000);
    touchConversation(s, "ghost", 5000);
    expect(s.conversations.ghost).toBeUndefined();
    const now = 1000 + ACTIVE_WINDOW_MS;
    touchConversation(s, "c", now);
    expect(activeConversations(s, now)).toEqual({ aaaaaa: 2, bbbbbb: 1 });
    expect(activeConversations(s, now + 1)).toEqual({ bbbbbb: 1 });
    expect(activeConversations({ ...s, conversations: { old: { accountId: "aaaaaa", at: 1 } } }, now)).toEqual({});
  });
});

describe("state schema", () => {
  it("keeps fields it does not know, so another version's writes survive a read-modify-write", () => {
    const d = dir();
    writeFileSync(join(d, "state.json"), JSON.stringify({ version: 1, future: 1, accounts: { a: { windows: {}, limitedUntil: null, needsLogin: false, extra: "x" } }, conversations: { c: { accountId: "a", at: 1, activeAt: 5, other: true } } }));
    updateState((s) => { s.accounts.a.needsLogin = true; }, d, 2);
    const raw = JSON.parse(require("node:fs").readFileSync(join(d, "state.json"), "utf8"));
    expect(raw.future).toBe(1);
    expect(raw.accounts.a.extra).toBe("x");
    expect(raw.conversations.c).toMatchObject({ activeAt: 5, other: true });
  });
});
