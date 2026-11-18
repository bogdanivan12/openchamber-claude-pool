import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaProviderSchemasV1 } from "@openchamber/sdk/schemas";
import { updateAccounts } from "../../shared/accounts.ts";
import { readState } from "../../shared/state.ts";
import { quotaRoute } from "./quota-route.ts";
import { refreshAllUsage, resetUsageCooldownsForTests } from "./usage.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pool-refresh-"));
  resetUsageCooldownsForTests();
  updateAccounts((f) => {
    f.accounts.push(
      { id: "aaaaaa", label: "a", configDir: join(dir, "a"), order: 0, enabled: true },
      { id: "bbbbbb", label: "b", configDir: join(dir, "b"), order: 1, enabled: true },
    );
  }, dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readCredential = async (d: string) => ({ accessToken: d.endsWith("/a") ? "ta" : "tb", expiresAt: null, subscriptionType: "pro" });
const body = { limits: [{ kind: "session", percent: 40, resets_at: "2030-01-01T00:00:00Z" }] };
type Mode = "ok" | "401" | "throw";
const fetchBy = (modes: { a: Mode; b: Mode }) => (async (_u: any, init: any) => {
  const mode = new Headers(init.headers).get("authorization") === "Bearer ta" ? modes.a : modes.b;
  if (mode === "throw") throw new Error("network down");
  return mode === "401" ? new Response("", { status: 401 }) : Response.json(body);
}) as any;

describe("refreshAllUsage", () => {
  it("one failing account does not affect the other; a later success clears needsLogin", async () => {
    await refreshAllUsage(dir, { readCredential, fetch: fetchBy({ a: "ok", b: "401" }) });
    let s = readState(dir);
    expect(s.accounts.aaaaaa.windows.five_hour?.usedPercent).toBe(40);
    expect(s.accounts.aaaaaa.needsLogin).toBe(false);
    expect(s.accounts.bbbbbb.needsLogin).toBe(true);
    expect(s.accounts.bbbbbb.windows.five_hour).toBeUndefined();
    await refreshAllUsage(dir, { readCredential, fetch: fetchBy({ a: "ok", b: "ok" }) });
    s = readState(dir);
    expect(s.accounts.bbbbbb.needsLogin).toBe(false);
    expect(s.accounts.bbbbbb.windows.five_hour?.usedPercent).toBe(40);
  });

  it("a network failure keeps the previous windows and the needsLogin flag", async () => {
    await refreshAllUsage(dir, { readCredential, fetch: fetchBy({ a: "ok", b: "401" }), now: () => 1000 });
    await refreshAllUsage(dir, { readCredential, fetch: fetchBy({ a: "throw", b: "throw" }), now: () => 2000 });
    const s = readState(dir);
    expect(s.accounts.aaaaaa.windows.five_hour?.usedPercent).toBe(40);
    expect(s.accounts.aaaaaa.needsLogin).toBe(false);
    expect(s.accounts.bbbbbb.needsLogin).toBe(true);
  });

  it("does not write state for an account removed while the reads were in flight", async () => {
    const slow = (async () => {
      updateAccounts((f) => { f.accounts = f.accounts.filter((a) => a.id !== "bbbbbb"); }, dir);
      return Response.json(body);
    }) as any;
    await refreshAllUsage(dir, { readCredential, fetch: slow });
    expect(readState(dir).accounts.bbbbbb).toBeUndefined();
    expect(readState(dir).accounts.aaaaaa).toBeDefined();
  });
});

const goodBody = JSON.stringify({ v: 1, requestId: "r1", method: "usage.read", provider: "ext-claude-pool", input: { credentials: {} } });
const req = (b: string) => ({ method: "POST", path: "/quota", query: new URLSearchParams(), body: b });

describe("POST /quota route", () => {
  it("rejects a body that is not a usage call with 400", async () => {
    const r = await quotaRoute({ dataDir: dir, readCredential, fetch: fetchBy({ a: "ok", b: "ok" }) })(req("{}"));
    expect(r.status).toBe(400);
  });

  it("answers a valid call with ok:true and a schema-valid, configured answer", async () => {
    const r = await quotaRoute({ dataDir: dir, readCredential, fetch: fetchBy({ a: "ok", b: "401" }) })(req(goodBody));
    expect(r.status).toBe(200);
    const out = r.body as { ok: boolean; data: any };
    expect(out.ok).toBe(true);
    expect(out.data.configured).toBe(true);
    expect(quotaProviderSchemasV1.usage.safeParse(out.data).success).toBe(true);
    expect(Object.keys(out.data.usage.models)).toContain("b (sign in again)");
  });
});
