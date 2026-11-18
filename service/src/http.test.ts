import { afterAll, describe, expect, it } from "bun:test";
import { connect, type AddressInfo } from "node:net";
import { createServer } from "./http.ts";
import { routes } from "./routes.ts";

const server = createServer(
  {
    ...routes,
    "POST /boom": () => {
      throw new Error("kaput");
    },
    "POST /json": (r) => ({ status: 200, body: JSON.parse(r.body) }),
    "POST /echo": (r) => ({ status: 200, body: { length: r.body.length } }),
    "DELETE /api/accounts/:id": (r) => ({ status: 200, body: { id: r.query.get("id") } }),
    "GET /x/:id": (r) => ({ status: 200, body: { id: r.query.get("id") } }),
  },
  "t",
);
server.listen(0, "127.0.0.1");
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = { authorization: "Bearer t" };
afterAll(() => server.close());

describe("service http hardening", () => {
  it("serves the real health route", async () => {
    expect(await (await fetch(`${base()}/health`, { headers: auth })).json()).toEqual({ ok: true });
  });
  it("a throwing route is 500 with a message only", async () => {
    const res = await fetch(`${base()}/boom`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "kaput" });
  });
  it("malformed JSON in a route is 400", async () => {
    const res = await fetch(`${base()}/json`, { method: "POST", headers: auth, body: "{nope" });
    expect(res.status).toBe(400);
  });
  it("a bad percent-escape in the path is 400", async () => {
    expect((await fetch(`${base()}/x/%E0%A4%A`, { headers: auth })).status).toBe(400);
  });
  it("accepts a body just under 1 MB and rejects one over it with 413", async () => {
    const ok = await fetch(`${base()}/echo`, { method: "POST", headers: auth, body: "a".repeat(1024 * 1024) });
    expect(await ok.json()).toEqual({ length: 1024 * 1024 });
    const big = await fetch(`${base()}/echo`, { method: "POST", headers: auth, body: "a".repeat(1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });
  it("a malformed request target is 400 and the server keeps serving", async () => {
    const port = (server.address() as AddressInfo).port;
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => sock.write("GET // HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nConnection: close\r\n\r\n"));
      let data = "";
      sock.on("data", (c) => (data += c));
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
    });
    expect(raw.startsWith("HTTP/1.1 400")).toBe(true);
    expect((await fetch(`${base()}/health`, { headers: auth })).status).toBe(200);
  });
  it("an unauthenticated request to an unknown path is 401, not 404", async () => {
    expect((await fetch(`${base()}/nope`)).status).toBe(401);
  });
  it("a path param wins over a same-named query param", async () => {
    const res = await fetch(`${base()}/api/accounts/abc?id=other`, { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ id: "abc" });
  });
});
