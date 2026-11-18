import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAccounts, updateAccounts } from "../../shared/accounts.ts";
import { accountRoutes } from "./accounts-api.ts";
import { envForDir, readAuthStatus } from "./auth-status.ts";
import { findImportCandidates } from "./import.ts";

const setup = (extra: Parameters<typeof accountRoutes>[0] = {}) => {
  const home = mkdtempSync(join(tmpdir(), "pool-api-home-"));
  const dataDir = join(home, ".claude-pool");
  const logouts: string[] = [];
  const routes = accountRoutes({
    dataDir, home,
    authStatus: async (dir) => ({ loggedIn: true, email: `${dir.split(/[\\/]/).pop()}@x.test`, plan: "pro" }),
    hasCredential: async () => true,
    cliFound: async () => true,
    logout: async (dir) => { logouts.push(dir); },
    ...extra,
  });
  const call = async (key: string, body: unknown = undefined, query = "") =>
    routes[key]({ method: key.split(" ")[0], path: key.split(" ")[1], query: new URLSearchParams(query), body: body === undefined ? "" : JSON.stringify(body) }) as Promise<any>;
  return { home, dataDir, call, logouts };
};

describe("account api", () => {
  it("imports dirs with their email and plan, skipping duplicates", async () => {
    const { home, dataDir, call } = setup();
    const out: any = await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b"), join(home, ".claude")] });
    expect(out.status).toBe(200);
    expect(out.body.added.map((a: any) => a.email)).toEqual([".claude@x.test", ".claude-b@x.test"]);
    expect(out.body.skipped[0].reason).toMatch(/already/);
    expect(readAccounts(dataDir).accounts.map((a) => a.order)).toEqual([0, 1]);
  });

  it("refuses an import whose login is missing", async () => {
    const { home, call } = setup({ authStatus: async () => ({ loggedIn: false, email: null, plan: null }), hasCredential: async () => false });
    const out: any = await call("POST /api/import", { configDirs: [join(home, ".claude")] });
    expect(out.body.added).toEqual([]);
    expect(out.body.skipped[0].reason).toMatch(/not signed in/);
  });

  it("skips a dir already in the pool under a different normalization", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude-b")] });
    const out: any = await call("POST /api/import", { configDirs: [`${join(home, ".claude-b")}/`, "~/.claude-b"] });
    expect(out.body.added).toEqual([]);
    expect(out.body.skipped.map((s: any) => s.reason)).toEqual(["already in the pool", "already in the pool"]);
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
  });

  it("rejects a malformed import body with 400", async () => {
    const { call } = setup();
    expect((await call("POST /api/import", { configDirs: "x" })).status).toBe(400);
    expect((await call("POST /api/import", { configDirs: [1] })).status).toBe(400);
  });

  it("derives unique labels from the email when names collide", async () => {
    const { home, dataDir, call } = setup({ authStatus: async () => ({ loggedIn: true, email: "Bob@x.test", plan: null }) });
    await call("POST /api/import", { configDirs: [join(home, ".claude-a"), join(home, ".claude-b"), join(home, ".claude-c")] });
    expect(readAccounts(dataDir).accounts.map((a) => a.label)).toEqual(["Bob", "Bob 2", "Bob 3"]);
  });

  it("keeps a collision-suffixed label within 40 characters", async () => {
    const long = "a".repeat(50);
    const { home, dataDir, call } = setup({ authStatus: async () => ({ loggedIn: true, email: `${long}@x.test`, plan: null }) });
    await call("POST /api/import", { configDirs: [join(home, ".claude-a"), join(home, ".claude-b")] });
    const labels = readAccounts(dataDir).accounts.map((a) => a.label);
    expect(labels[0]).toBe("a".repeat(40));
    expect(labels[1].length).toBeLessThanOrEqual(40);
    expect(labels[1].endsWith(" 2")).toBe(true);
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(2);
  });

  it("renames, disables, reorders and sets the threshold", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    expect((await call("PATCH /api/accounts/:id", { label: "Work" }, `id=${a.id}`)).body.label).toBe("Work");
    await call("PATCH /api/accounts/:id", { enabled: false }, `id=${b.id}`);
    await call("POST /api/accounts/reorder", { ids: [b.id, a.id] });
    const after = readAccounts(dataDir);
    expect(after.accounts.find((x) => x.id === b.id)).toMatchObject({ enabled: false, order: 0 });
    expect((await call("PUT /api/settings", { threshold: 80 })).body.threshold).toBe(80);
    expect((await call("PUT /api/settings", { threshold: 10 })).status).toBe(400);
  });

  it("rejects a label another account uses (case-insensitive, trimmed) but allows re-saving your own", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude-a"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    await call("PATCH /api/accounts/:id", { label: "Work" }, `id=${a.id}`);
    const clash = await call("PATCH /api/accounts/:id", { label: "  wORK " }, `id=${b.id}`);
    expect(clash.status).toBe(400);
    expect(clash.body).toEqual({ error: "Another account already uses this name" });
    expect(readAccounts(dataDir).accounts.find((x) => x.id === b.id)!.label).not.toBe("Work");
    const own = await call("PATCH /api/accounts/:id", { label: "WORK" }, `id=${a.id}`);
    expect(own.status).toBe(200);
    expect(own.body.label).toBe("WORK");
  });

  it("answers 400 (not 500) for an invalid label and 404 for an unknown account", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude-a")] });
    const [a] = readAccounts(dataDir).accounts;
    expect((await call("PATCH /api/accounts/:id", { label: "   " }, `id=${a.id}`)).status).toBe(400);
    expect((await call("PATCH /api/accounts/:id", { label: "x".repeat(41) }, `id=${a.id}`)).status).toBe(400);
    expect(readAccounts(dataDir).accounts[0].label).toBe(a.label);
    expect((await call("PATCH /api/accounts/:id", { label: "ok" }, "id=ffffff")).status).toBe(404);
  });

  it("reorder keeps a stable total order with unknown and missing ids", async () => {
    const { dataDir, call } = setup();
    updateAccounts((f) => {
      for (const [i, id] of ["aaaaaa", "bbbbbb", "cccccc", "dddddd"].entries()) {
        f.accounts.push({ id, label: id, configDir: `/x/${id}`, order: i, enabled: true });
      }
    }, dataDir);
    const out = await call("POST /api/accounts/reorder", { ids: ["cccccc", "zzzzzz", "aaaaaa"] });
    expect(out.status).toBe(200);
    const after = readAccounts(dataDir).accounts.sort((x, y) => x.order - y.order);
    expect(after.map((a) => a.id)).toEqual(["cccccc", "aaaaaa", "bbbbbb", "dddddd"]);
    expect(after.map((a) => a.order)).toEqual([0, 1, 2, 3]);
    expect((await call("POST /api/accounts/reorder", { ids: "nope" })).status).toBe(400);
  });

  it("accepts thresholds 50 and 100 and rejects 49, 101, 90.5 and \"90\"", async () => {
    const { dataDir, call } = setup();
    for (const ok of [50, 100]) {
      expect((await call("PUT /api/settings", { threshold: ok })).body.threshold).toBe(ok);
      expect(readAccounts(dataDir).threshold).toBe(ok);
    }
    for (const bad of [49, 101, 90.5, "90"]) {
      expect((await call("PUT /api/settings", { threshold: bad })).status).toBe(400);
    }
    expect(readAccounts(dataDir).threshold).toBe(100);
  });

  it("removes an account; logs out and deletes the login only for pool-created dirs", async () => {
    const { home, dataDir, call, logouts } = setup();
    const created = join(dataDir, "accounts", "abcdef");
    mkdirSync(created, { recursive: true });
    updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true });
      f.accounts.push({ id: "123456", label: "old", configDir: join(home, ".claude-b"), order: 1, enabled: true });
    }, dataDir);
    expect((await call("DELETE /api/accounts/:id", undefined, "id=abcdef&deleteLogin=1")).body.deletedLogin).toBe(true);
    expect(existsSync(created)).toBe(false);
    expect(logouts).toEqual([created]);
    const kept = await call("DELETE /api/accounts/:id", undefined, "id=123456&deleteLogin=1");
    expect(kept.body.deletedLogin).toBe(false);
    expect(logouts).toEqual([created]);
    expect(readAccounts(dataDir).accounts).toEqual([]);
  });

  it("does not log out or delete when deleteLogin is not requested", async () => {
    const { dataDir, call, logouts } = setup();
    const created = join(dataDir, "accounts", "abcdef");
    mkdirSync(created, { recursive: true });
    updateAccounts((f) => { f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true }); }, dataDir);
    const out = await call("DELETE /api/accounts/:id", undefined, "id=abcdef");
    expect(out.body).toEqual({ ok: true, deletedLogin: false });
    expect(existsSync(created)).toBe(true);
    expect(logouts).toEqual([]);
  });

  it("still removes the account when the logout throws", async () => {
    const { dataDir, call } = setup({ logout: async () => { throw new Error("boom"); } });
    const created = join(dataDir, "accounts", "abcdef");
    mkdirSync(created, { recursive: true });
    updateAccounts((f) => { f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true }); }, dataDir);
    const out = await call("DELETE /api/accounts/:id", undefined, "id=abcdef&deleteLogin=1");
    expect(out.body.deletedLogin).toBe(true);
    expect(existsSync(created)).toBe(false);
  });

  it("answers 404 when deleting an unknown account", async () => {
    const { call, logouts } = setup();
    const out = await call("DELETE /api/accounts/:id", undefined, "id=ffffff&deleteLogin=1");
    expect(out.status).toBe(404);
    expect(logouts).toEqual([]);
  });

  it("lists accounts with state and canDeleteLogin", async () => {
    const { home, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude")] });
    const out: any = await call("GET /api/accounts");
    expect(out.body.accounts[0]).toMatchObject({ canDeleteLogin: false, poolActive: true });
    expect(out.body.threshold).toBe(90);
    expect(out.body.cliFound).toBe(true);
    expect(out.body.recoveredBackup).toBe(false);
  });

  it("reports cliFound false when the CLI is missing", async () => {
    const { call } = setup({ cliFound: async () => false });
    expect((await call("GET /api/accounts")).body.cliFound).toBe(false);
  });

  it("never returns credentials", async () => {
    const { home, call } = setup({ hasCredential: async () => true });
    await call("POST /api/import", { configDirs: [join(home, ".claude")] });
    const text = JSON.stringify([await call("GET /api/accounts"), await call("GET /api/import-candidates")]);
    expect(text).not.toMatch(/accessToken|refreshToken/);
  });
});

describe("import candidates", () => {
  it("default dir and .claude-* dirs with a login, not already added, not the pool dir", async () => {
    const home = "/h";
    const c = await findImportCandidates({
      home, existing: [join(home, ".claude-x")],
      listHome: () => [".claude", ".claude-b", ".claude-x", ".claude-pool", ".claude.json", "other"],
      hasCredential: async (d) => !d.endsWith(".claude-nologin"),
    });
    expect(c).toEqual([join(home, ".claude"), join(home, ".claude-b")]);
  });

  it("omits dirs without credentials", async () => {
    const c = await findImportCandidates({
      home: "/h", existing: [],
      listHome: () => [".claude", ".claude-nologin", ".claude-ok"],
      hasCredential: async (d) => !d.endsWith(".claude-nologin"),
    });
    expect(c).toEqual(["/h/.claude", "/h/.claude-ok"]);
  });

  it("GET route hides ~/.claude-pool and non-directories on a real home", async () => {
    const { home, call } = setup();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".claude-b"));
    mkdirSync(join(home, ".claude-pool"), { recursive: true });
    writeFileSync(join(home, ".claude-file"), "x");
    mkdirSync(join(home, "other"));
    const out = await call("GET /api/import-candidates");
    expect(out.body.candidates).toEqual([join(home, ".claude"), join(home, ".claude-b")]);
  });

  it("GET route leaves out dirs lacking credentials and ones already in the pool", async () => {
    const { home, call } = setup({ hasCredential: async (d) => !d.endsWith(".claude-nologin") });
    for (const n of [".claude", ".claude-nologin", ".claude-b"]) mkdirSync(join(home, n));
    await call("POST /api/import", { configDirs: [join(home, ".claude-b")] });
    expect((await call("GET /api/import-candidates")).body.candidates).toEqual([join(home, ".claude")]);
  });
});

describe("auth status", () => {
  it("parses the CLI json", async () => {
    const info = await readAuthStatus("/x", { run: async () => 'noise {"loggedIn":true,"email":"a@b.c","subscriptionType":"max"} tail' });
    expect(info).toEqual({ loggedIn: true, email: "a@b.c", plan: "max" });
  });

  it("degrades to signed-out on empty or broken output", async () => {
    const out = { loggedIn: false, email: null, plan: null };
    expect(await readAuthStatus("/x", { run: async () => null })).toEqual(out);
    expect(await readAuthStatus("/x", { run: async () => "not json" })).toEqual(out);
  });

  it("envForDir drops CLAUDE_CONFIG_DIR for the default dir and sets it otherwise", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/stale";
    try {
      expect(envForDir(join(homedir(), ".claude")).CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(envForDir("/some/other").CLAUDE_CONFIG_DIR).toBe("/some/other");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
