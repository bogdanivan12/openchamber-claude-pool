import { describe, expect, it } from "bun:test";
import type { Account } from "./accounts.ts";
import { emptyState, markLimited, recordWindow, setNeedsLogin, accountState } from "./state.ts";
import { NEAR_FULL_PERCENT, STALE_USAGE_MS, accountsToFreshen } from "./usage.ts";

const acc = (id: string, enabled = true): Account => ({ id, label: id, configDir: `/${id}`, order: 0, enabled });
const NOW = 10_000_000;
const OLD = NOW - STALE_USAGE_MS - 1;
const ids = (list: Account[]) => list.map((a) => a.id);

describe("accountsToFreshen", () => {
  it("an account without numbers is always read", () => {
    expect(ids(accountsToFreshen([acc("aaaaaa")], emptyState(), NOW, { newConversation: false }))).toEqual(["aaaaaa"]);
  });

  it("fresh numbers are never re-read", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 99, resetsAt: null, updatedAt: NOW - 1000 });
    expect(accountsToFreshen([acc("aaaaaa")], s, NOW, { newConversation: true })).toEqual([]);
  });

  it("stale numbers: a running conversation re-reads only accounts near full; a new one re-reads all", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: NEAR_FULL_PERCENT, resetsAt: null, updatedAt: OLD });
    recordWindow(s, "bbbbbb", "seven_day", { usedPercent: 40, resetsAt: null, updatedAt: OLD });
    recordWindow(s, "cccccc", "five_hour", { usedPercent: 95, resetsAt: NOW - 1, updatedAt: OLD }); // already reset
    const all = [acc("aaaaaa"), acc("bbbbbb"), acc("cccccc")];
    expect(ids(accountsToFreshen(all, s, NOW, { newConversation: false }))).toEqual(["aaaaaa"]);
    expect(ids(accountsToFreshen(all, s, NOW, { newConversation: true }))).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
  });

  it("skips disabled, signed-out, limited and cooling-down accounts", () => {
    const s = emptyState();
    setNeedsLogin(s, "bbbbbb", true);
    markLimited(s, "cccccc", NOW + 1);
    accountState(s, "dddddd").usageCooldownUntil = NOW + 1;
    const all = [acc("aaaaaa", false), acc("bbbbbb"), acc("cccccc"), acc("dddddd")];
    expect(accountsToFreshen(all, s, NOW, { newConversation: true })).toEqual([]);
  });
});
