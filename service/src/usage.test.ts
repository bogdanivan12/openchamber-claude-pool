import { describe, expect, it } from "bun:test";
import { parseUsagePayload, readAccountUsage } from "./usage.ts";

const account = { id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true };
const cred = async () => ({ accessToken: "tok", expiresAt: null, subscriptionType: "pro" });

describe("usage", () => {
  it("reads the limits array", () => {
    const r = parseUsagePayload({ limits: [
      { kind: "session", percent: 42, resets_at: "2026-11-18T20:00:00Z" },
      { kind: "weekly_all", percent: 71, resets_at: "2026-11-22T00:00:00Z" },
    ] });
    expect(r.windows.five_hour).toEqual({ usedPercent: 42, resetsAt: Date.parse("2026-11-18T20:00:00Z") });
    expect(r.windows.seven_day?.usedPercent).toBe(71);
  });

  it("falls back to legacy fields", () => {
    const r = parseUsagePayload({ five_hour: { utilization: 12, resets_at: "2026-11-18T20:00:00Z" }, seven_day: { utilization: 3, resets_at: null } });
    expect(r.windows.five_hour?.usedPercent).toBe(12);
    expect(r.windows.seven_day).toEqual({ usedPercent: 3, resetsAt: null });
  });

  it("sends the bearer and beta header; 401 means needsLogin", async () => {
    let seen: Headers | undefined;
    const ok = await readAccountUsage(account, { readCredential: cred, fetch: (async (_u: any, init: any) => { seen = new Headers(init.headers); return Response.json({ limits: [] }); }) as any });
    expect(seen?.get("authorization")).toBe("Bearer tok");
    expect(seen?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(ok.ok).toBe(true);
    const denied = await readAccountUsage({ ...account, id: "bbbbbb" }, { readCredential: cred, fetch: (async () => new Response("", { status: 401 })) as any });
    expect(denied).toMatchObject({ ok: false, needsLogin: true });
  });

  it("no credential is a sign-in error; an expired token is reported, not refreshed", async () => {
    expect(await readAccountUsage({ ...account, id: "cccccc" }, { readCredential: async () => null })).toMatchObject({ ok: false, needsLogin: true, error: expect.stringContaining("No Claude login found (or the Keychain denied access)") });
    const expired = await readAccountUsage({ ...account, id: "dddddd" }, { now: () => 10, readCredential: async () => ({ accessToken: "t", expiresAt: 5, subscriptionType: "max" }), fetch: (async () => { throw new Error("must not call"); }) as any });
    expect(expired).toMatchObject({ ok: false, plan: "max" });
  });

  it("a 429 starts a cooldown for that account only", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "120" } }); }) as any;
    const acc = { ...account, id: "eeeeee" };
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 });
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 2000 });
    expect(calls).toBe(1);
  });

  it("a 429 without retry-after uses the 5 minute default", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("", { status: 429 }); }) as any;
    const acc = { ...account, id: "ffffff" };
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 });
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 + 4 * 60_000 });
    expect(calls).toBe(1);
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 + 5 * 60_000 + 1 });
    expect(calls).toBe(2);
  });

  it("retry-after: 0 ends the cooldown immediately", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "0" } }); }) as any;
    const acc = { ...account, id: "abcabc" };
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 });
    await readAccountUsage(acc, { readCredential: cred, fetch: f, now: () => 1000 });
    expect(calls).toBe(2);
  });

  it("a throwing readCredential is an error result, not a rejection", async () => {
    const r = await readAccountUsage({ ...account, id: "123456" }, { readCredential: async () => { throw new Error("boom"); } });
    expect(r).toMatchObject({ ok: false, plan: null });
  });

  it("a credential read error is an error result without needsLogin", async () => {
    const r = await readAccountUsage({ ...account, id: "654321" }, { readCredentialDetailed: async () => ({ cred: null, reason: "error", message: "Keychain access failed (exit 51)" }) });
    expect(r.ok).toBe(false);
    expect((r as any).needsLogin).toBeUndefined();
    expect((r as any).error).toContain("could not read this account's login (Keychain access failed (exit 51))");
    expect((r as any).error).toContain("allow it; reload to retry");
  });

  it("a not-found credential is still needsLogin", async () => {
    const r = await readAccountUsage({ ...account, id: "654322" }, { readCredentialDetailed: async () => ({ cred: null, reason: "not-found" }) });
    expect(r).toMatchObject({ ok: false, needsLogin: true });
  });
});
