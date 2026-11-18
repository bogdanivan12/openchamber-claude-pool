import { describe, expect, it } from "bun:test";
import { api, classifyRequestError, errorText } from "./api.ts";

const host = (impl: (r: { method: string; path: string; query?: Record<string, string> }) => Promise<{ status: number; body: string }>) => ({ serviceRequest: impl });

describe("api", () => {
  it("classifies host rejections", () => {
    const noService = Object.assign(new Error("no service"), { code: "NO_SERVICE" });
    expect(classifyRequestError(noService).message).toContain("Re-approve the extension in Settings → Extensions");
    expect(classifyRequestError(noService).message).toContain("no service");
    expect(classifyRequestError(new Error("SERVICE_FAILED: exited")).message).toStartWith("The Claude Pool service stopped; try again.");
    expect(classifyRequestError(new Error("boom")).message).toBe("boom");
  });
  it("never renders an object error as [object Object]", async () => {
    expect(errorText({ a: 1 })).toBe('{"a":1}');
    const c = api(host(async () => ({ status: 400, body: JSON.stringify({ error: { code: "x" } }) })));
    await expect(c.list()).rejects.toThrow('{"code":"x"}');
  });
  it("encodes account ids in paths and wraps rejections", async () => {
    const seen: string[] = [];
    const c = api(host(async (r) => { seen.push(r.path); return { status: 200, body: "{}" }; }));
    await c.patch("a/b c", { enabled: true });
    await c.remove("a/b c", false);
    expect(seen).toEqual(["/api/accounts/a%2Fb%20c", "/api/accounts/a%2Fb%20c"]);
    const bad = api(host(async () => { throw Object.assign(new Error("x"), { code: "SERVICE_FAILED" }); }));
    await expect(bad.list()).rejects.toThrow("service stopped");
  });
});
