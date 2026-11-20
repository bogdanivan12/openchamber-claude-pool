import { describe, expect, it } from "bun:test";
import type { Account } from "./accounts.ts";
import { emptyState, markLimited, recordWindow, setNeedsLogin } from "./state.ts";
import { headroom, isAvailable, nextAvailableAt, route } from "./router.ts";

const acc = (id: string, order: number, enabled = true): Account => ({ id, label: id, configDir: `/${id}`, order, enabled });
const A = acc("aaaaaa", 0), B = acc("bbbbbb", 1), C = acc("cccccc", 2);
const NOW = 1_000_000;
const win = (pct: number, resetsAt: number | null = NOW + 3600_000) => ({ usedPercent: pct, resetsAt, updatedAt: NOW });

describe("router", () => {
  it("availability honours enabled, needsLogin, limitedUntil and full windows", () => {
    const s = emptyState();
    expect(isAvailable(A, s.accounts.aaaaaa, NOW)).toBe(true);
    expect(isAvailable(acc("dddddd", 3, false), undefined, NOW)).toBe(false);
    setNeedsLogin(s, "aaaaaa", true);
    expect(isAvailable(A, s.accounts.aaaaaa, NOW)).toBe(false);
    setNeedsLogin(s, "aaaaaa", false);
    markLimited(s, "aaaaaa", NOW + 10);
    expect(isAvailable(A, s.accounts.aaaaaa, NOW)).toBe(false);
    expect(isAvailable(A, s.accounts.aaaaaa, NOW + 11)).toBe(true);
    recordWindow(s, "bbbbbb", "seven_day", win(99));
    expect(isAvailable(B, s.accounts.bbbbbb, NOW)).toBe(true);
    recordWindow(s, "bbbbbb", "seven_day", win(100));
    expect(isAvailable(B, s.accounts.bbbbbb, NOW)).toBe(false);
  });

  it("a window whose reset passed counts as empty", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(99, NOW - 1));
    expect(isAvailable(A, s.accounts.aaaaaa, NOW)).toBe(true);
    expect(headroom(s.accounts.aaaaaa, NOW)).toBe(100);
  });

  it("headroom is the tightest window", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(10));
    recordWindow(s, "aaaaaa", "seven_day", win(70));
    expect(headroom(s.accounts.aaaaaa, NOW)).toBe(30);
  });

  it("keeps the conversation's current account while it is available", () => {
    const s = emptyState();
    recordWindow(s, "bbbbbb", "five_hour", win(80));
    const r = route({ accounts: [A, B], state: s, now: NOW, current: "bbbbbb" });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
  });

  it("otherwise picks the most headroom, ties by order", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(50));
    recordWindow(s, "bbbbbb", "five_hour", win(20));
    let r = route({ accounts: [A, B, C], state: s, now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("cccccc"); // no data = 100 headroom
    r = route({ accounts: [A, B], state: s, now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
    r = route({ accounts: [B, A], state: emptyState(), now: NOW });
    expect(r.kind === "account" && r.account.id).toBe("aaaaaa");
  });

  it("skips excluded and unavailable accounts and moves off a full current one", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", win(100));
    const r = route({ accounts: [A, B], state: s, now: NOW, current: "aaaaaa", exclude: new Set(["cccccc"]) });
    expect(r.kind === "account" && r.account.id).toBe("bbbbbb");
  });

  it("none available returns the earliest moment one frees up", () => {
    const s = emptyState();
    markLimited(s, "aaaaaa", NOW + 500);
    recordWindow(s, "bbbbbb", "five_hour", win(100, NOW + 200));
    expect(nextAvailableAt(B, s.accounts.bbbbbb, NOW)).toBe(NOW + 200);
    expect(route({ accounts: [A, B], state: s, now: NOW })).toEqual({ kind: "none", retryAt: NOW + 200 });
  });

  it("none with only logged-out accounts has no retry time", () => {
    const s = emptyState();
    setNeedsLogin(s, "aaaaaa", true);
    expect(route({ accounts: [A], state: s, now: NOW })).toEqual({ kind: "none", retryAt: null });
  });
});
