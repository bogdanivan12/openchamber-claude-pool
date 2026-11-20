import { describe, expect, it } from "bun:test";
import { accountKind, resetText, statusBadge, windowPercent } from "./format.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const base = { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true, poolActive: false, canDeleteLogin: false };

describe("format", () => {
  it("badges in priority order", () => {
    expect(statusBadge({ ...base, enabled: false, state: null }, NOW)).toEqual({ label: "Disabled", tone: "neutral" });
    expect(statusBadge({ ...base, state: { windows: {}, limitedUntil: null, needsLogin: true } }, NOW)).toEqual({ label: "Sign in again", tone: "error" });
    expect(statusBadge({ ...base, state: { windows: {}, limitedUntil: NOW + 90 * 60_000, needsLogin: false } }, NOW)).toEqual({ label: "Limited · 1h 30m", tone: "warning" });
    expect(statusBadge({ ...base, poolActive: true, state: null }, NOW)).toEqual({ label: "In use now", tone: "success" });
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

describe("accountKind", () => {
  const b = { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true, poolActive: false, canDeleteLogin: false, state: null } as any;
  it("separates in use, available and unavailable", () => {
    expect(accountKind({ ...b, poolActive: true }, 1000).kind).toBe("use");
    expect(accountKind(b, 1000).kind).toBe("ready");
    expect(accountKind({ ...b, available: false }, 1000).kind).toBe("out");
    expect(accountKind({ ...b, poolActive: true, state: { windows: {}, limitedUntil: 5000, needsLogin: false } }, 1000).kind).toBe("out");
    expect(accountKind({ ...b, state: { windows: {}, limitedUntil: null, needsLogin: true } }, 1000).kind).toBe("out");
  });
});
