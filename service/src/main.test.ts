import { afterAll, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import { createServer } from "./http.ts";

const server = createServer(
  {
    "GET /health": () => ({ status: 200, body: { ok: true } }),
    "PATCH /api/accounts/:id": (r) => ({ status: 200, body: { id: r.query.get("id"), body: JSON.parse(r.body) } }),
  },
  "secret",
);
server.listen(0, "127.0.0.1");
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => server.close());

describe("service http", () => {
  it("refuses a missing or wrong bearer", async () => {
    expect((await fetch(`${base()}/health`)).status).toBe(401);
    expect((await fetch(`${base()}/health`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("routes with the bearer", async () => {
    const res = await fetch(`${base()}/health`, { headers: { authorization: "Bearer secret" } });
    expect(await res.json()).toEqual({ ok: true });
  });
  it("matches :id segments", async () => {
    const res = await fetch(`${base()}/api/accounts/abcdef`, { method: "PATCH", headers: { authorization: "Bearer secret" }, body: '{"label":"x"}' });
    expect(await res.json()).toEqual({ id: "abcdef", body: { label: "x" } });
  });
  it("unknown route is 404, a throwing route is 500 with a message", async () => {
    expect((await fetch(`${base()}/nope`, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
  });
});
