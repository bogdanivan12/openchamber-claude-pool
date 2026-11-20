import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAccounts, updateAccounts } from "../../shared/accounts.ts";
import { updateState } from "../../shared/state.ts";
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
  it("refreshes usage when the list is read, at most once per throttle window, and survives a failing refresh", async () => {
    let n = 0;
    const { call } = setup({ refreshUsage: async () => { n++; throw new Error("boom"); } });
    expect((await call("GET /api/accounts")).status).toBe(200);
    await call("GET /api/accounts");
    expect(n).toBe(1);
  });

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

  it("two concurrent imports of the same dir add one account and neither throws", async () => {
    const { home, dataDir, call } = setup({ authStatus: async () => { await new Promise((r) => setTimeout(r, 5)); return { loggedIn: true, email: "a@x.test", plan: null }; } });
    const dir = join(home, ".claude-a");
    const [one, two] = await Promise.all([call("POST /api/import", { configDirs: [dir] }), call("POST /api/import", { configDirs: [dir] })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
    const results = [one, two].map((o) => o.body);
    expect(results.flatMap((b) => b.added)).toHaveLength(1);
    const skipped = results.flatMap((b) => b.skipped);
    expect(skipped).toEqual([{ configDir: dir, reason: "already in the pool" }]);
  });

  it("reports a per-dir failure in skipped instead of failing the whole import", async () => {
    const { home, call } = setup({ authStatus: async (d) => { if (d.endsWith("-bad")) throw new Error("probe exploded"); return { loggedIn: true, email: "a@x.test", plan: null }; } });
    const out = await call("POST /api/import", { configDirs: [join(home, ".claude-bad"), join(home, ".claude-good")] });
    expect(out.status).toBe(200);
    expect(out.body.added).toHaveLength(1);
    expect(out.body.skipped).toEqual([{ configDir: join(home, ".claude-bad"), reason: "probe exploded" }]);
  });

  it("falls back to 'account N' when the email has an empty local part", async () => {
    const { home, dataDir, call } = setup({ authStatus: async () => ({ loggedIn: true, email: " @x.test", plan: null }) });
    await call("POST /api/import", { configDirs: [join(home, ".claude-a"), join(home, ".claude-b")] });
    expect(readAccounts(dataDir).accounts.map((a) => a.label)).toEqual(["account 1", "account 2"]);
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

  it("renames, disables, re-enables and reorders", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    const renamed = await call("PATCH /api/accounts/:id", { label: "Work" }, `id=${a.id}`);
    expect(renamed.body).toMatchObject({ label: "Work", id: a.id, configDir: a.configDir, enabled: true });
    await call("PATCH /api/accounts/:id", { enabled: false }, `id=${b.id}`);
    expect(readAccounts(dataDir).accounts.find((x) => x.id === b.id)!.enabled).toBe(false);
    await call("POST /api/accounts/reorder", { ids: [b.id, a.id] });
    const after = readAccounts(dataDir);
    expect(after.accounts.find((x) => x.id === b.id)).toMatchObject({ enabled: false, order: 0 });
    expect(after.accounts.find((x) => x.id === a.id)).toMatchObject({ order: 1, configDir: a.configDir });
    const back = await call("PATCH /api/accounts/:id", { enabled: true }, `id=${b.id}`);
    expect(back.body).toMatchObject({ enabled: true, id: b.id, configDir: b.configDir });
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

  it("removes an account; logs out and deletes the login only for pool-created dirs", async () => {
    const { home, dataDir, call, logouts } = setup();
    const created = join(dataDir, "accounts", "abcdef");
    const outside = join(home, ".claude-b");
    mkdirSync(created, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "x");
    updateAccounts((f) => {
      f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true });
      f.accounts.push({ id: "123456", label: "old", configDir: outside, order: 1, enabled: true });
      f.accounts.push({ id: "654321", label: "third", configDir: join(home, ".claude-c"), order: 2, enabled: true });
    }, dataDir);
    expect((await call("DELETE /api/accounts/:id", undefined, "id=abcdef&deleteLogin=1")).body.deletedLogin).toBe(true);
    expect(existsSync(created)).toBe(false);
    expect(logouts).toEqual([created]);
    expect(readAccounts(dataDir).accounts.map((a) => [a.id, a.order])).toEqual([["123456", 0], ["654321", 1]]);
    const kept = await call("DELETE /api/accounts/:id", undefined, "id=123456&deleteLogin=1");
    expect(kept.body.deletedLogin).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(logouts).toEqual([created]);
    expect(readAccounts(dataDir).accounts.map((a) => [a.id, a.order])).toEqual([["654321", 0]]);
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

  it("marks accounts with recently active conversations as in use, each one, and idle accounts as not", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    updateState((st) => {
      st.accounts[a.id] = { windows: { five_hour: { usedPercent: 79, resetsAt: null, updatedAt: 1 } }, limitedUntil: null, needsLogin: false };
      st.accounts[b.id] = { windows: { five_hour: { usedPercent: 3, resetsAt: null, updatedAt: 1 } }, limitedUntil: null, needsLogin: false };
      st.conversations.s1 = { accountId: a.id, at: Date.now(), activeAt: Date.now() };
      st.conversations.s2 = { accountId: a.id, at: Date.now(), activeAt: Date.now() };
      st.conversations.s3 = { accountId: b.id, at: Date.now(), activeAt: Date.now() - 10 * 60_000 }; // idle
    }, dataDir);
    let out: any = await call("GET /api/accounts");
    expect(out.body.accounts[0]).toMatchObject({ id: a.id, poolActive: true, activeChats: 2, nextChat: false });
    expect(out.body.accounts[1]).toMatchObject({ id: b.id, poolActive: false, activeChats: 0, nextChat: true, available: true });
    updateState((st) => { st.conversations.s4 = { accountId: b.id, at: Date.now(), activeAt: Date.now() }; }, dataDir);
    out = await call("GET /api/accounts");
    expect(out.body.accounts.map((x: any) => x.poolActive)).toEqual([true, true]);
  });

  it("lists accounts with their state, the picked account and the backup flag", async () => {
    const { home, dataDir, call } = setup();
    await call("POST /api/import", { configDirs: [join(home, ".claude"), join(home, ".claude-b")] });
    const [a, b] = readAccounts(dataDir).accounts;
    updateState((st) => {
      st.accounts[b.id] = { windows: { five_hour: { usedPercent: 12, resetsAt: null, updatedAt: 1 } }, limitedUntil: null, needsLogin: false };
    }, dataDir);
    const out: any = await call("GET /api/accounts");
    expect(out.body.accounts.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect(out.body.accounts[0]).toMatchObject({ canDeleteLogin: false, poolActive: false, nextChat: true, state: null });
    expect(out.body.accounts[1]).toMatchObject({ canDeleteLogin: false, poolActive: false });
    expect(out.body.accounts[1].state.windows.five_hour.usedPercent).toBe(12);
    expect(out.body.threshold).toBeUndefined();
    expect(out.body.cliFound).toBe(true);
    expect(out.body.recoveredBackup).toBe(false);
  });

  it("recoveredBackup is true while accounts.json.bak exists and the ack clears it", async () => {
    const { dataDir, call } = setup();
    expect((await call("POST /api/accounts/ack-backup")).body).toEqual({ ok: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "accounts.json.bak"), "{broken");
    expect((await call("GET /api/accounts")).body.recoveredBackup).toBe(true);
    const ack = await call("POST /api/accounts/ack-backup");
    expect(ack).toEqual({ status: 200, body: { ok: true } });
    expect((await call("GET /api/accounts")).body.recoveredBackup).toBe(false);
    expect(existsSync(join(dataDir, "accounts.json.bak"))).toBe(false);
    expect(readdirSync(dataDir).some((n) => n.startsWith("accounts.json.bak.ack-"))).toBe(true);
    expect((await call("POST /api/accounts/ack-backup")).body).toEqual({ ok: true });
  });

  it("reports cliFound false when the CLI is missing", async () => {
    const { call } = setup({ cliFound: async () => false });
    expect((await call("GET /api/accounts")).body.cliFound).toBe(false);
  });

  it("never puts a credential in any response", async () => {
    const SECRET = "sk-ant-oat01-SENTINEL-DO-NOT-LEAK";
    const home = mkdtempSync(join(tmpdir(), "pool-api-home-"));
    for (const n of [".claude", ".claude-b"]) {
      mkdirSync(join(home, n));
      writeFileSync(join(home, n, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET } }));
    }
    const dataDir = join(home, ".claude-pool");
    const reads: string[] = [];
    const { call } = setup({
      dataDir, home,
      hasCredential: async (dir) => { reads.push(readFileSync(join(dir, ".credentials.json"), "utf8")); return true; },
    });
    updateState((st) => { st.accounts["aaaaaa"] = { windows: {}, limitedUntil: null, needsLogin: true }; }, dataDir);
    const bodies = [
      await call("GET /api/import-candidates"),
      await call("POST /api/import", { configDirs: [join(home, ".claude")] }),
      await call("GET /api/accounts"),
    ].map((r) => JSON.stringify(r));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.includes(SECRET))).toBe(true);
    for (const body of bodies) expect(body).not.toContain(SECRET);
  });

  it("has no settings route: the switch threshold is gone", () => {
    expect(accountRoutes()["PUT /api/settings"]).toBeUndefined();
  });

  it("answers 400 for a body that is not a JSON object, in every route that reads one", async () => {
    const { dataDir, call } = setup();
    updateAccounts((f) => { f.accounts.push({ id: "aaaaaa", label: "a", configDir: "/x/a", order: 0, enabled: true }); }, dataDir);
    for (const body of [null, [], "text", 7]) {
      for (const [key, q] of [["POST /api/import", ""], ["PATCH /api/accounts/:id", "id=aaaaaa"], ["POST /api/accounts/reorder", ""]] as const) {
        const out = await call(key, body, q);
        expect([key, out.status, out.body]).toEqual([key, 400, { error: "Expected a JSON object" }]);
      }
    }
  });

  it("answers 400 for a non-string label or non-boolean enabled", async () => {
    const { dataDir, call } = setup();
    updateAccounts((f) => { f.accounts.push({ id: "aaaaaa", label: "a", configDir: "/x/a", order: 0, enabled: true }); }, dataDir);
    for (const patch of [{ label: 5 }, { label: null }, { enabled: "yes" }, { enabled: 1 }]) {
      expect((await call("PATCH /api/accounts/:id", patch, "id=aaaaaa")).status).toBe(400);
    }
    expect(readAccounts(dataDir).accounts[0]).toMatchObject({ label: "a", enabled: true });
  });

  const cannotBlockWrites = process.platform === "win32" || process.getuid?.() === 0;

  it.skipIf(cannotBlockWrites)("surfaces a storage failure as a server error, not a 400", async () => {
    const { dataDir, call } = setup();
    updateAccounts((f) => { f.accounts.push({ id: "aaaaaa", label: "a", configDir: "/x/a", order: 0, enabled: true }); }, dataDir);
    chmodSync(dataDir, 0o500);
    try {
      // The route rethrows; http.ts maps a thrown error to 500. A 400 would come back as a resolved response.
      const outcome = await Promise.resolve().then(() => call("PATCH /api/accounts/:id", { label: "b" }, "id=aaaaaa")).then(
        (res) => ({ resolved: res }),
        (err) => ({ thrown: err as Error }),
      );
      expect(outcome).not.toHaveProperty("resolved");
      const thrown = (outcome as { thrown: Error }).thrown;
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).not.toMatch(/already uses this name/);
      expect(thrown.message).toMatch(/EACCES|EPERM|permission|denied/i);
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(readAccounts(dataDir).accounts[0].label).toBe("a");
  });

  it("removes the account and warns (200) when deleting the login dir fails", async () => {
    const removed: string[] = [];
    const { dataDir, call } = setup({ rm: (path) => { removed.push(path); throw new Error("EBUSY: resource busy"); } });
    const created = join(dataDir, "accounts", "abcdef");
    mkdirSync(created, { recursive: true });
    updateAccounts((f) => { f.accounts.push({ id: "abcdef", label: "new", configDir: created, order: 0, enabled: true }); }, dataDir);
    const out = await call("DELETE /api/accounts/:id", undefined, "id=abcdef&deleteLogin=1");
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, deletedLogin: false, warning: "EBUSY: resource busy" });
    expect(removed).toEqual([created]);
    expect(readAccounts(dataDir).accounts).toEqual([]);
    expect(existsSync(created)).toBe(true);
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
    expect(c).toEqual([join("/h", ".claude"), join("/h", ".claude-ok")]);
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
    const info = await readAuthStatus("/x", { run: async () => 'noise {"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"} tail' });
    expect(info).toEqual({ loggedIn: true, email: "a@b.c", plan: "max" });
  });

  it("only subscription logins count as signed in", async () => {
    const run = (j: object) => async () => JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "pro", ...j });
    expect((await readAuthStatus("/x", { run: run({ authMethod: "claude.ai", apiProvider: "firstParty" }) })).loggedIn).toBe(true);
    expect((await readAuthStatus("/x", { run: run({ authMethod: "oauth" }) })).loggedIn).toBe(true);
    expect((await readAuthStatus("/x", { run: run({ authMethod: "api_key" }) })).loggedIn).toBe(false);
    expect((await readAuthStatus("/x", { run: run({ authMethod: "claude.ai", apiProvider: "bedrock" }) })).loggedIn).toBe(false);
  });

  it("the import route skips API-key and third-party logins with a clear reason", async () => {
    const payloads: Record<string, object> = {
      ".claude-key": { authMethod: "api_key" },
      ".claude-aws": { authMethod: "claude.ai", apiProvider: "bedrock" },
      ".claude-ok": { authMethod: "claude.ai", apiProvider: "firstParty" },
    };
    const { home, dataDir, call } = setup({
      authStatus: (dir) => readAuthStatus(dir, { run: async () => JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "pro", ...payloads[dir.split(/[\\/]/).pop()!] }) }),
    });
    const out = await call("POST /api/import", { configDirs: Object.keys(payloads).map((n) => join(home, n)) });
    expect(out.body.added.map((a: any) => a.configDir)).toEqual([join(home, ".claude-ok")]);
    expect(out.body.skipped.map((x: any) => x.reason)).toEqual(Array(2).fill("not signed in to a Claude subscription (API-key and third-party logins are not supported)"));
    expect(readAccounts(dataDir).accounts).toHaveLength(1);
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
