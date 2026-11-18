import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccounts, updateAccounts } from "../../shared/accounts.ts";
import { readState, setNeedsLogin, updateState } from "../../shared/state.ts";
import { labelTaken } from "./accounts-api.ts";
import { loginRoutes, type LoginRelay } from "./login.ts";

function fakeRelay(result: "ok" | "bad") {
  const envs: Array<Record<string, string | undefined>> = [];
  const relay: LoginRelay = {
    start: async (env) => { envs.push(env); return { state: "awaiting-code", url: "https://claude.ai/oauth/authorize?x=1" }; },
    submit: async () => (result === "ok" ? { ok: true } : { ok: false, message: "Invalid code" }),
    cancel: () => {},
  };
  return { relay, envs };
}
const call = (routes: any, key: string, body?: unknown) =>
  routes[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(), body: body === undefined ? "" : JSON.stringify(body) });

describe("login", () => {
  it("new account: creates the dir, relays the URL, adds the account on success", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    const { relay, envs } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "me@x.test", plan: "max" }) });
    const started = (await call(routes, "POST /api/login/start", { label: "Second" })).body;
    expect(started).toMatchObject({ state: "awaiting-code", url: "https://claude.ai/oauth/authorize?x=1", label: "Second" });
    const dir = envs[0].CLAUDE_CONFIG_DIR!;
    expect(dir.startsWith(join(dataDir, "accounts"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const done = (await call(routes, "POST /api/login/code", { code: "abc#def" })).body;
    expect(done).toMatchObject({ state: "succeeded", duplicateOf: null });
    expect(readAccounts(dataDir).accounts[0]).toMatchObject({ label: "Second", email: "me@x.test", plan: "max", configDir: dir });
  });

  it("failed code keeps nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    const { relay, envs } = fakeRelay("bad");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: false, email: null, plan: null }) });
    await call(routes, "POST /api/login/start", { label: "X" });
    const out = (await call(routes, "POST /api/login/code", { code: "nope" })).body;
    expect(out).toMatchObject({ state: "failed" });
    expect(readAccounts(dataDir).accounts).toEqual([]);
    expect(existsSync(envs[0].CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  it("duplicate email is reported", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    updateAccounts((f) => f.accounts.push({ id: "aaaaaa", label: "a", configDir: "/a", order: 0, enabled: true, email: "me@x.test" }), dataDir);
    const { relay } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "me@x.test", plan: "pro" }) });
    await call(routes, "POST /api/login/start", { label: "dup" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "succeeded", duplicateOf: "aaaaaa" });
  });

  it("sign in again reuses the account dir and clears needsLogin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    updateAccounts((f) => f.accounts.push({ id: "bbbbbb", label: "b", configDir: join(dataDir, "accounts", "bbbbbb"), order: 0, enabled: true }), dataDir);
    updateState((s) => setNeedsLogin(s, "bbbbbb", true), dataDir);
    const { relay, envs } = fakeRelay("ok");
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "b@x.test", plan: "pro" }) });
    await call(routes, "POST /api/login/start", { accountId: "bbbbbb" });
    expect(envs[0].CLAUDE_CONFIG_DIR).toBe(join(dataDir, "accounts", "bbbbbb"));
    await call(routes, "POST /api/login/code", { code: "c" });
    expect(readState(dataDir).accounts.bbbbbb.needsLogin).toBe(false);
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
  });
});

function harness(opts: { result?: "ok" | "bad"; startFails?: boolean; auth?: { loggedIn: boolean; email: string | null; plan: string | null } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
  const log = { envs: [] as Array<Record<string, string | undefined>>, cancels: 0, logouts: [] as string[], rms: [] as string[], order: [] as string[] };
  const relay: LoginRelay = {
    start: async (env) => {
      log.envs.push(env);
      if (opts.startFails) return { state: "failed", message: "no claude" };
      return { state: "awaiting-code", url: "https://claude.ai/x" };
    },
    submit: async () => (opts.result === "bad" ? { ok: false, message: "Invalid code" } : { ok: true }),
    cancel: () => { log.cancels++; log.order.push("cancel"); },
  };
  const routes = loginRoutes({
    dataDir, relay,
    authStatus: async () => opts.auth ?? { loggedIn: true, email: "n@x.test", plan: "pro" },
    logout: async (d) => { log.logouts.push(d); log.order.push("logout"); },
    rm: (p) => { log.rms.push(p); log.order.push("rm"); },
  });
  return { dataDir, log, routes };
}
const addAccount = (dataDir: string, id: string, label: string, email?: string) =>
  updateAccounts((f) => f.accounts.push({ id, label, configDir: join(dataDir, "accounts", id), order: f.accounts.length, enabled: true, ...(email ? { email } : {}) }), dataDir);

describe("login validation", () => {
  it("labelTaken compares trimmed and case-insensitively, optionally excluding an id", () => {
    const accounts = [{ id: "aaaaaa", label: "Work", configDir: "/a", order: 0, enabled: true }];
    expect(labelTaken(accounts, "  work ")).toBe(true);
    expect(labelTaken(accounts, "work", "aaaaaa")).toBe(false);
    expect(labelTaken(accounts, "home")).toBe(false);
  });

  it("start with a used label is 400 and creates no dir", async () => {
    const { dataDir, log, routes } = harness();
    addAccount(dataDir, "aaaaaa", "Work");
    const r = await call(routes, "POST /api/login/start", { label: " WORK " });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Another account already uses this name" });
    expect(log.envs).toHaveLength(0);
    expect(existsSync(join(dataDir, "accounts"))).toBe(false);
  });

  it("start rejects bad labels, non-object bodies and unknown accounts without side effects", async () => {
    const { log, routes } = harness();
    expect((await call(routes, "POST /api/login/start", { label: "" })).status).toBe(400);
    expect((await call(routes, "POST /api/login/start", { label: "x".repeat(41) })).status).toBe(400);
    expect((await call(routes, "POST /api/login/start", { label: 5 })).status).toBe(400);
    expect((await call(routes, "POST /api/login/start", {})).status).toBe(400);
    expect(await call(routes, "POST /api/login/start", [1])).toEqual({ status: 400, body: { error: "Expected a JSON object" } });
    expect(await call(routes, "POST /api/login/code", "str")).toEqual({ status: 400, body: { error: "Expected a JSON object" } });
    expect((await call(routes, "POST /api/login/start", { accountId: "zzzzzz" })).status).toBe(404);
    expect(log.envs).toHaveLength(0);
  });

  it("code: empty is 400, none pending is 409", async () => {
    const { routes } = harness();
    expect((await call(routes, "POST /api/login/code", { code: "abc" })).status).toBe(409);
    await call(routes, "POST /api/login/start", { label: "A" });
    expect((await call(routes, "POST /api/login/code", { code: "  " })).status).toBe(400);
    expect((await call(routes, "POST /api/login/code", {})).status).toBe(400);
  });

  it("GET shows the current view; succeeded view carries the account and no token", async () => {
    const { routes } = harness();
    expect((await call(routes, "GET /api/login")).body).toEqual({ state: "idle" });
    await call(routes, "POST /api/login/start", { label: "A" });
    expect((await call(routes, "GET /api/login")).body).toMatchObject({ state: "awaiting-code", label: "A" });
    await call(routes, "POST /api/login/code", { code: "c" });
    const v = (await call(routes, "GET /api/login")).body as any;
    expect(v).toMatchObject({ state: "succeeded", account: { label: "A", email: "n@x.test", plan: "pro" } });
    expect(JSON.stringify(v)).not.toMatch(/token|secret|credential/i);
  });

  it("duplicate email of another account still succeeds with duplicateOf (case-insensitive)", async () => {
    const { dataDir, routes } = harness({ auth: { loggedIn: true, email: "N@X.test", plan: "pro" } });
    addAccount(dataDir, "aaaaaa", "a", "n@x.test");
    await call(routes, "POST /api/login/start", { label: "dup" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "succeeded", duplicateOf: "aaaaaa" });
    expect(readAccounts(dataDir).accounts).toHaveLength(2);
  });

  it("succeeds when authStatus says logged in even if the relay rejected the code", async () => {
    const { dataDir, routes } = harness({ result: "bad" });
    await call(routes, "POST /api/login/start", { label: "A" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "succeeded" });
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
  });

  it("a label taken while the login was pending does not lose the sign-in: it gets a suffix", async () => {
    const { dataDir, routes } = harness();
    await call(routes, "POST /api/login/start", { label: "Race" });
    addAccount(dataDir, "cccccc", "race");
    const v = (await call(routes, "POST /api/login/code", { code: "c" })).body as any;
    expect(v.state).toBe("succeeded");
    expect(v.account.label).toBe("Race 2");
  });
});

describe("login discarding a pending new account", () => {
  it("rejected code: cancel, then logout, then rm, once each, on the pool dir", async () => {
    const { log, routes } = harness({ result: "bad", auth: { loggedIn: false, email: null, plan: null } });
    await call(routes, "POST /api/login/start", { label: "X" });
    const dir = log.envs[0].CLAUDE_CONFIG_DIR!;
    log.cancels = 0; log.order.length = 0;
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "failed", message: "Invalid code" });
    expect(log.logouts).toEqual([dir]);
    expect(log.rms).toEqual([dir]);
    expect(log.cancels).toBe(1);
    expect(log.order).toEqual(["cancel", "logout", "rm"]);
    expect((await call(routes, "POST /api/login/code", { code: "c" })).status).toBe(409);
  });

  it("relay start failure discards the new dir", async () => {
    const { log, routes } = harness({ startFails: true });
    const v = (await call(routes, "POST /api/login/start", { label: "X" })).body;
    expect(v).toEqual({ state: "failed", message: "no claude" });
    const dir = log.envs[0].CLAUDE_CONFIG_DIR!;
    expect(log.logouts).toEqual([dir]);
    expect(log.rms).toEqual([dir]);
  });

  it("cancel discards a new account and answers idle", async () => {
    const { log, routes } = harness();
    await call(routes, "POST /api/login/start", { label: "X" });
    const dir = log.envs[0].CLAUDE_CONFIG_DIR!;
    expect((await call(routes, "POST /api/login/cancel")).body).toEqual({ state: "idle" });
    expect(log.logouts).toEqual([dir]);
    expect(log.rms).toEqual([dir]);
    expect((await call(routes, "GET /api/login")).body).toEqual({ state: "idle" });
  });

  it("cancel with nothing pending touches no dirs", async () => {
    const { log, routes } = harness();
    expect((await call(routes, "POST /api/login/cancel")).body).toEqual({ state: "idle" });
    expect(log.logouts).toHaveLength(0);
    expect(log.rms).toHaveLength(0);
  });

  it("existing account: failure and cancel never logout or rm", async () => {
    const { dataDir, log, routes } = harness({ result: "bad", auth: { loggedIn: false, email: null, plan: null } });
    addAccount(dataDir, "bbbbbb", "b");
    await call(routes, "POST /api/login/start", { accountId: "bbbbbb" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "failed" });
    await call(routes, "POST /api/login/start", { accountId: "bbbbbb" });
    await call(routes, "POST /api/login/cancel");
    expect(log.logouts).toHaveLength(0);
    expect(log.rms).toHaveLength(0);
    expect(log.cancels).toBeGreaterThan(0);
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
  });

  it("a logout or rm that throws does not break the discard", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    const { relay } = fakeRelay("bad");
    const routes = loginRoutes({
      dataDir, relay, authStatus: async () => ({ loggedIn: false, email: null, plan: null }),
      logout: async () => { throw new Error("boom"); }, rm: () => { throw new Error("busy"); },
    });
    await call(routes, "POST /api/login/start", { label: "X" });
    expect((await call(routes, "POST /api/login/code", { code: "c" })).body).toMatchObject({ state: "failed" });
  });

  it("start while another login is pending cancels it and discards its new dir", async () => {
    const { log, routes } = harness();
    await call(routes, "POST /api/login/start", { label: "First" });
    const first = log.envs[0].CLAUDE_CONFIG_DIR!;
    log.cancels = 0;
    const v = (await call(routes, "POST /api/login/start", { label: "Second" })).body;
    expect(v).toMatchObject({ state: "awaiting-code", label: "Second" });
    expect(log.logouts).toEqual([first]);
    expect(log.rms).toEqual([first]);
    expect(log.cancels).toBeGreaterThanOrEqual(1);
    expect(log.envs[1].CLAUDE_CONFIG_DIR).not.toBe(first);
  });

  it("an invalid start leaves the pending login alone", async () => {
    const { log, routes } = harness();
    await call(routes, "POST /api/login/start", { label: "First" });
    expect((await call(routes, "POST /api/login/start", { label: "" })).status).toBe(400);
    expect(log.rms).toHaveLength(0);
    expect((await call(routes, "GET /api/login")).body).toMatchObject({ state: "awaiting-code", label: "First" });
  });

  it("a cancel during verification wins: the late result is not applied", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pool-login-"));
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const rms: string[] = [];
    const relay: LoginRelay = {
      start: async () => ({ state: "awaiting-code", url: "u" }),
      submit: async () => { await gate; return { ok: true }; },
      cancel: () => {},
    };
    const routes = loginRoutes({ dataDir, relay, authStatus: async () => ({ loggedIn: true, email: "z@x.test", plan: "pro" }), logout: async () => {}, rm: (p) => { rms.push(p); } });
    await call(routes, "POST /api/login/start", { label: "X" });
    const inflight = call(routes, "POST /api/login/code", { code: "c" });
    expect((await call(routes, "POST /api/login/code", { code: "again" })).status).toBe(409);
    await call(routes, "POST /api/login/cancel");
    release();
    expect((await inflight).body).toEqual({ state: "idle" });
    expect(readAccounts(dataDir).accounts).toEqual([]);
    expect(rms).toHaveLength(1);
  });
});
