import { describe, expect, it } from "bun:test";
import { quotaProviderSchemasV1 } from "@openchamber/sdk/schemas";
import { emptyState, markLimited, recordWindow, setNeedsLogin } from "../../shared/state.ts";
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
      accounts: [A, B], state: s, now: NOW,
      reads: { aaaaaa: { ok: true, windows: {}, plan: "pro" }, bbbbbb: { ok: true, windows: {}, plan: "max" } },
    });
    expect(data.ok).toBe(true);
    expect(data.usage?.windows["5h"]).toMatchObject({ usedPercent: 10, windowSeconds: 18000, resetAt: RESET, valueLabel: "home" });
    expect(Object.keys(data.usage?.models ?? {})).toEqual(["work", "home"]);
    expect(data.usage?.models?.home.windows["7d"].usedPercent).toBe(30);
    expect(data.planLabel).toBe("Pro ×1, Max ×1");
    expect(quotaProviderSchemasV1.usage.safeParse(data).success).toBe(true);
  });

  it("a signed-out account shows in its group label and the card still answers", () => {
    const s = emptyState();
    setNeedsLogin(s, "aaaaaa", true);
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 5, resetsAt: RESET, updatedAt: NOW });
    const data = buildQuotaAnswer({ accounts: [A, B], state: s, now: NOW, reads: { aaaaaa: { ok: false, error: "expired", needsLogin: true, plan: null }, bbbbbb: { ok: true, windows: {}, plan: "pro" } } });
    expect(data.ok).toBe(true);
    expect(Object.keys(data.usage?.models ?? {})).toContain("work (sign in again)");
    expect(quotaProviderSchemasV1.usage.safeParse(data).success).toBe(true);
  });

  it("no data at all is ok:false with the first error", () => {
    const data = buildQuotaAnswer({ accounts: [A], state: emptyState(), now: NOW, reads: { aaaaaa: { ok: false, error: "network down", plan: null } } });
    expect(data).toMatchObject({ ok: false, configured: true });
    expect(data.error).toContain("network down");
  });

  it("no accounts is configured:true with a pointer to the panel", () => {
    const data = buildQuotaAnswer({ accounts: [], state: emptyState(), now: NOW, reads: {} });
    expect(data).toMatchObject({ ok: false, configured: true });
    expect(data.error).toMatch(/Claude Pool panel/);
  });

  it("a failed read shows how old the stored data is, never when the read succeeded or is absent", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 20, resetsAt: RESET, updatedAt: NOW - 12 * 60_000 });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 20, resetsAt: RESET, updatedAt: NOW - 3 * 3600_000 });
    const failed = { ok: false as const, error: "network down", plan: null };
    const names = (reads: any) => Object.keys(buildQuotaAnswer({ accounts: [A, B], state: s, now: NOW, reads }).usage?.models ?? {});
    expect(names({ aaaaaa: failed, bbbbbb: failed })).toEqual(["work (data 12 min old)", "home (data 3 h old)"]);
    expect(names({ aaaaaa: { ok: true, windows: {}, plan: null } })).toEqual(["work", "home"]);
    expect(names({})).toEqual(["work", "home"]);
  });

  it("sign-in outranks limited outranks stale", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 20, resetsAt: RESET, updatedAt: NOW - 60_000 });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 20, resetsAt: RESET, updatedAt: NOW - 60_000 });
    setNeedsLogin(s, "aaaaaa", true);
    markLimited(s, "bbbbbb", NOW + 1000);
    const failed = { ok: false as const, error: "x", plan: null };
    const data = buildQuotaAnswer({ accounts: [A, B], state: s, now: NOW, reads: { aaaaaa: failed, bbbbbb: failed } });
    expect(Object.keys(data.usage?.models ?? {})).toEqual(["work (sign in again)", "home (limited)"]);
  });

  it("accounts with the same label both appear under unique names", () => {
    const s = emptyState();
    recordWindow(s, "aaaaaa", "five_hour", { usedPercent: 20, resetsAt: RESET, updatedAt: NOW });
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 30, resetsAt: RESET, updatedAt: NOW });
    const data = buildQuotaAnswer({ accounts: [A, { ...B, label: "work" }], state: s, now: NOW, reads: {} });
    expect(Object.keys(data.usage?.models ?? {})).toEqual(["work", "work #bbbb"]);
    expect(quotaProviderSchemasV1.usage.safeParse(data).success).toBe(true);
  });

  it("when nothing is routable the top group is the first account with data", () => {
    const s = emptyState();
    recordWindow(s, "bbbbbb", "five_hour", { usedPercent: 99, resetsAt: RESET, updatedAt: NOW });
    markLimited(s, "aaaaaa", NOW + 1000);
    markLimited(s, "bbbbbb", NOW + 1000);
    const data = buildQuotaAnswer({ accounts: [A, B], state: s, now: NOW, reads: {} });
    expect(data.usage?.windows["5h"]).toMatchObject({ usedPercent: 99, valueLabel: "home" });
  });
});
