import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createPanel } from "./app.ts";
import type { Ctx } from "./ctx.ts";
import { VERIFY_MAX_POLLS } from "./login-flow.ts";
import { account, buttonLabels, click, menu, fieldNote, FakeService, findButton, installDom, makeHost, settle, text, typeInto, uninstallDom } from "./test-helpers.ts";

const NOW = Date.now();
let currentHost: ReturnType<typeof makeHost>["host"];
mock.module("@openchamber/sdk", () => ({ connectHost: () => currentHost }));

beforeAll(installDom);
afterAll(uninstallDom);

let svc: FakeService;
let root: HTMLElement;
let h: ReturnType<typeof makeHost>;
let ctx: Ctx;
let sleeps: number[];

beforeEach(() => {
  svc = new FakeService();
  sleeps = [];
});

async function open(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.querySelector("#root") as HTMLElement;
  h = makeHost(svc);
  currentHost = h.host;
  ctx = createPanel(h.host, root, { sleep: async (ms) => { sleeps.push(ms); } });
  await settle();
}

describe("panel smoke test (happy-dom, fake service)", () => {
  it("shows Loading… before the first answer", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const r = document.querySelector("#root") as HTMLElement;
    const never = { serviceRequest: () => new Promise<never>(() => {}), openUrl: async () => {}, onReady: () => () => {} };
    createPanel(never as never, r);
    expect(text(r)).toContain("Loading…");
  });

  it("renders accounts with badges and usage bars", async () => {
    svc.accounts = [
      account("a1", "work", { email: "w@x.com", plan: "max", poolActive: true, state: { windows: { five_hour: { usedPercent: 72, resetsAt: NOW + 3600_000, updatedAt: NOW }, seven_day: { usedPercent: 10, resetsAt: NOW + 86400_000, updatedAt: NOW } }, limitedUntil: null, needsLogin: false } }),
      account("a2", "home", { enabled: false }),
    ];
    await open();
    const t = text(root);
    expect(t).toContain("work");
    expect(t).toContain("w@x.com · MAX");
    expect(t).toContain("In use now");
    expect(t).toContain("Disabled");
    expect(t).toContain("72%");
    expect(root.querySelectorAll("[role=progressbar]").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the missing-CLI error banner", async () => {
    svc.cliFound = false;
    await open();
    expect(text(root)).toContain("Claude Code CLI not found");
  });

  it("shows the backup banner and Dismiss acknowledges it", async () => {
    svc.recoveredBackup = true;
    await open();
    expect(text(root)).toContain("accounts.json was unreadable");
    await click(root, "Dismiss");
    expect(svc.find("POST", "/api/accounts/ack-backup")).toHaveLength(1);
    expect(text(root)).not.toContain("accounts.json was unreadable");
  });

  it("add account: name -> code screen -> wrong code -> failed banner -> Back -> list", async () => {
    await open();
    await click(root, "Add account");
    await click(root, "Start");
    expect(text(root)).toContain("Enter a name.");
    await typeInto(root, "Name for the new account", "work");
    expect(fieldNote(root, "Name for the new account")).toBe("");
    await click(root, "Start");
    expect(svc.find("POST", "/api/login/start")[0].body).toEqual({ label: "work" });
    expect(h.opened).toEqual(["https://claude.test/oauth/authorize"]);
    expect(text(root)).toContain("A wrong code cancels this sign-in; you would need to start again.");
    await typeInto(root, "Code", "bad");
    await click(root, "Finish sign-in");
    expect(text(root)).toContain("Sign-in failed");
    expect(text(root)).toContain("That code was not accepted.");
    await click(root, "Back");
    expect(svc.loginState).toBe("idle");
    expect(buttonLabels(root)).toContain("Add account");
    expect(text(root)).not.toContain("Sign-in failed");
  });

  it("add account success with a duplicate: banner, then Remove the duplicate deletes the new id", async () => {
    svc.accounts = [account("old1", "personal")];
    svc.duplicateOf = "old1";
    await open();
    await click(root, "Add account");
    await typeInto(root, "Name for the new account", "work");
    await click(root, "Start");
    await typeInto(root, "Code", "good");
    await click(root, "Finish sign-in");
    expect(text(root)).toContain("already in the pool under another name");
    expect(text(root)).toContain('"personal"');
    expect(buttonLabels(root)).toContain("Dismiss");
    await click(root, "Remove the duplicate");
    const del = svc.find("DELETE", "/api/accounts/newacct");
    expect(del).toHaveLength(1);
    expect(del[0].query).toBeUndefined();
    expect(svc.accounts.map((a) => a.id)).toEqual(["old1"]);
    expect(svc.loginState).toBe("idle");
    expect(text(root)).not.toContain("already in the pool under another name");
  });

  it("dismissing a result banner resets the service login to idle", async () => {
    svc.duplicateOf = "x";
    await open();
    await click(root, "Add account");
    await typeInto(root, "Name for the new account", "work");
    await click(root, "Start");
    await typeInto(root, "Code", "good");
    await click(root, "Finish sign-in");
    expect(svc.loginState).toBe("succeeded");
    await click(root, "Dismiss");
    expect(svc.loginState).toBe("idle");
  });

  it("resumes an awaiting-code login on load without reopening the page", async () => {
    svc.login = { state: "awaiting-code", url: "https://claude.test/x", accountId: "newacct", label: "work" };
    await open();
    expect(text(root)).toContain('Sign in "work"');
    expect(buttonLabels(root)).toContain("Finish sign-in");
    expect(h.opened).toEqual([]);
  });

  it("resumes a verifying login: polls (bounded, via the injected sleep) and refreshes the list", async () => {
    svc.login = { state: "verifying" };
    svc.verifyingLeft = 2;
    svc.onVerified = () => { svc.accounts.push(account("newacct", "zelda")); svc.login = { state: "succeeded", account: account("newacct", "zelda"), duplicateOf: null }; };
    await open();
    // the load-time GET counts as the first verifying answer, so two more polls follow
    expect(sleeps).toEqual([1000, 1000]);
    expect(text(root)).toContain("zelda");
    expect(buttonLabels(root)).toContain("Add account");
    expect(svc.loginState).toBe("idle");
  });

  it("gives up polling a stuck verifying login after the bound", async () => {
    svc.login = { state: "verifying" };
    svc.verifyingLeft = 1_000_000;
    await open();
    expect(sleeps).toHaveLength(VERIFY_MAX_POLLS);
    expect(text(root)).toContain("The sign-in is taking too long");
    expect(buttonLabels(root)).toContain("Add account");
  });

  it("a stale succeeded or failed view on load shows nothing and is reset", async () => {
    for (const stale of [
      { state: "succeeded", account: account("z", "z"), duplicateOf: "q", warning: "w" },
      { state: "failed", message: "old failure" },
    ] as const) {
      svc = new FakeService();
      svc.login = stale as never;
      await open();
      expect(text(root)).not.toContain("old failure");
      expect(text(root)).not.toContain("already in the pool");
      expect(text(root)).not.toContain("Signed in");
      expect(svc.find("POST", "/api/login/cancel")).toHaveLength(1);
      expect(svc.loginState).toBe("idle");
    }
  });

  it("emailChanged and warning views are surfaced as banners", async () => {
    svc.accounts = [account("a1", "work")];
    svc.login = { state: "awaiting-code", url: "u", accountId: "a1", label: "work" };
    svc.accounts[0].state = { windows: {}, limitedUntil: null, needsLogin: true };
    await open();
    expect(text(root)).toContain('Sign in again as "work"');
    expect(text(root)).not.toContain("A wrong code cancels this sign-in; you would need to start again.");
    svc.accounts[0].state = null;
    const orig = svc.serviceRequest.bind(svc);
    svc.serviceRequest = async (r) => {
      if (r.path === "/api/login/code") { svc.login = { state: "succeeded", account: svc.accounts[0], duplicateOf: null, emailChanged: { from: "a@x.com", to: "b@x.com" }, warning: "usage could not be read" }; return { status: 200, body: JSON.stringify(svc.login) }; }
      return orig(r);
    };
    await typeInto(root, "Code", "good");
    await click(root, "Finish sign-in");
    expect(text(root)).toContain("Signed in as b@x.com (was a@x.com)");
    expect(text(root)).toContain("usage could not be read");
  });

  it("remove is two-step and sends deleteLogin only when ticked and allowed", async () => {
    svc.accounts = [account("a1", "work", { canDeleteLogin: true }), account("a2", "home")];
    await open();
    await menu(root, "Remove", 0);
    expect(text(root)).toContain("Remove work?");
    expect(svc.find("DELETE", "/api/accounts/a1")).toHaveLength(0);
    const box = Array.from(root.querySelectorAll("[role=checkbox]")).find((b) => b.textContent?.includes("Also sign out")) as HTMLElement;
    expect(box).toBeTruthy();
    box.click();
    await settle();
    // the confirm button is the second "Remove" in the card row
    const confirm = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Remove")[0] as HTMLButtonElement;
    confirm.click();
    await settle();
    expect(svc.find("DELETE", "/api/accounts/a1")[0].query).toEqual({ deleteLogin: "1" });
    // account without canDeleteLogin: no checkbox, no deleteLogin
    await menu(root, "Remove", 0);
    expect(text(root)).toContain("Remove home?");
    expect(root.querySelector("[role=checkbox]")).toBeNull();
    const confirm2 = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Remove")[0] as HTMLButtonElement;
    confirm2.click();
    await settle();
    expect(svc.find("DELETE", "/api/accounts/a2")[0].query).toBeUndefined();
  });

  it("remove can be cancelled without a request", async () => {
    svc.accounts = [account("a1", "work")];
    await open();
    await menu(root, "Remove");
    await click(root, "Cancel");
    expect(svc.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(text(root)).not.toContain("Remove work?");
  });

  it("import: candidates, select, import, skipped banner", async () => {
    svc.candidates = ["/home/u/.claude", "/home/u/.claude-work"];
    svc.skipped = [{ configDir: "/home/u/.claude-work", reason: "not signed in" }];
    await open();
    await click(root, "Import");
    expect(text(root)).toContain("/home/u/.claude-work");
    await click(root, "Import selected");
    expect(text(root)).toContain("Select at least one login to import.");
    await click(root, "Import selected");
    expect(root.querySelectorAll("[role=alert],[role=status]").length).toBeGreaterThan(0);
    const boxes = Array.from(root.querySelectorAll("[role=checkbox]")) as HTMLElement[];
    boxes[0].click(); boxes[1].click();
    await settle();
    await click(root, "Import selected");
    expect(svc.find("POST", "/api/import")[0].body).toEqual({ configDirs: ["/home/u/.claude", "/home/u/.claude-work"] });
    expect(text(root)).toContain("/home/u/.claude-work: not signed in");
    expect(svc.accounts).toHaveLength(1);
    expect(text(root)).toContain(".claude");
  });

  it("repeated empty import selection does not stack identical banners", async () => {
    svc.candidates = ["/home/u/.claude"];
    await open();
    await click(root, "Import");
    await click(root, "Import selected");
    await click(root, "Import selected");
    expect(text(root).split("Select at least one login to import.").length - 1).toBe(1);
  });

  it("rename: a duplicate name shows the service error, typing clears it, a valid name saves", async () => {
    svc.accounts = [account("a1", "work"), account("a2", "home")];
    await open();
    await menu(root, "Rename", 0);
    await typeInto(root, "New name", "home");
    await click(root, "Save");
    expect(fieldNote(root, "New name")).toContain('There is already an account called "home"');
    await typeInto(root, "New name", "homee");
    expect(fieldNote(root, "New name")).toBe("");
    await click(root, "Save");
    expect(svc.accounts[0].label).toBe("homee");
    expect(text(root)).toContain("homee");
  });

  it("threshold: invalid input shows an error, keeps it across re-render, and never calls the API", async () => {
    await open();
    await typeInto(root, "Switch accounts at", "150");
    await click(root, "Save");
    expect(svc.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(fieldNote(root, "Switch accounts at")).toBe("Enter a whole number from 50 to 100.");
    ctx.render();
    expect(fieldNote(root, "Switch accounts at")).toBe("Enter a whole number from 50 to 100.");
    await typeInto(root, "Switch accounts at", "80");
    expect(fieldNote(root, "Switch accounts at")).not.toContain("whole number");
    await click(root, "Save");
    expect(svc.find("PUT", "/api/settings")[0].body).toEqual({ threshold: 80 });
    expect(svc.threshold).toBe(80);
  });

  it("enabling toggle, reorder and refresh hit the API", async () => {
    svc.accounts = [account("a1", "work"), account("a2", "home")];
    await open();
    const sw = root.querySelector("[role=switch]") as HTMLElement;
    sw.click();
    await settle();
    expect(svc.find("PATCH", "/api/accounts/a1")[0].body).toEqual({ enabled: false });
    await menu(root, "Move down", 0);
    expect(svc.find("POST", "/api/accounts/reorder")[0].body).toEqual({ ids: ["a2", "a1"] });
    const before = svc.find("GET", "/api/accounts").length;
    await click(root, "Refresh");
    expect(svc.find("GET", "/api/accounts").length).toBe(before + 1);
  });

  it("a rejected service request shows a friendly banner, then Try again recovers", async () => {
    svc.reject = Object.assign(new Error("no service"), { code: "NO_SERVICE" });
    await open();
    expect(text(root)).toContain("did not answer");
    expect(text(root)).toContain("Re-approve the extension in Settings → Extensions");
    svc.reject = null;
    await click(root, "Try again");
    expect(buttonLabels(root)).toContain("Add account");
    expect(text(root)).not.toContain("Re-approve");
  });

  it("a failed mutation shows an error banner and the list keeps working", async () => {
    svc.accounts = [account("a1", "work")];
    await open();
    svc.accounts = [];
    await menu(root, "Remove");
    await click(root, "Remove");
    expect(text(root)).toContain("That did not work");
    expect(text(root)).toContain("No such account");
    expect(buttonLabels(root)).toContain("Add account");
  });

  it("openUrl failure shows the address in an error banner", async () => {
    await open();
    h.openUrlError.value = new Error("popup blocked");
    await click(root, "Add account");
    await typeInto(root, "Name for the new account", "work");
    await click(root, "Start");
    expect(text(root)).toContain("Could not open the sign-in page");
    expect(text(root)).toContain("https://claude.test/oauth/authorize");
    await click(root, "Open the sign-in page");
    expect(text(root)).toContain("popup blocked");
  });

  it("a code sent after the service restarted returns to a working list with an error", async () => {
    svc.login = { state: "awaiting-code", url: "u", accountId: "newacct", label: "work" };
    await open();
    svc.login = { state: "idle" }; // service restarted
    await typeInto(root, "Code", "good");
    await click(root, "Finish sign-in");
    expect(text(root)).toContain("No sign-in in progress");
    expect(buttonLabels(root)).toContain("Add account");
  });

  it("refreshes when the host context moves to another project, not on an identical ready", async () => {
    await open();
    const n = () => svc.find("GET", "/api/accounts").length;
    const before = n();
    h.ready("/project/a");
    await settle();
    expect(n()).toBe(before);
    h.ready("/project/b");
    await settle();
    expect(n()).toBe(before + 1);
  });

  it("the header summarises the pool and says where a new chat goes", async () => {
    svc.accounts = [account("a1", "work", { nextChat: true, available: true }), account("a2", "home", { available: false })];
    await open();
    expect(text(root)).toContain("1 of 2 accounts available · new chats go to work");
  });

  it("How it works opens the FAQ with the key answers and Back returns to the list", async () => {
    svc.accounts = [account("a1", "work")];
    await open();
    await click(root, "How it works");
    const t = text(root);
    expect(t).toContain("How Claude Pool works");
    expect(t).toContain("Which account does a new chat start on?");
    expect(t).toContain("What happens when every account is at its limit?");
    expect(root.querySelectorAll("details").length).toBeGreaterThanOrEqual(10);
    expect(buttonLabels(root)).not.toContain("Add account");
    // a refresh while reading must not throw the reader back to the list
    ctx.screen.kind === "help" && (await ctx.refresh());
    expect(text(root)).toContain("How Claude Pool works");
    await click(root, "Back");
    expect(buttonLabels(root)).toContain("Add account");
    expect(text(root)).not.toContain("How Claude Pool works");
  });

  it("the real entry (main.ts) mounts through the mocked connectHost", async () => {
    svc.accounts = [account("a1", "entry-test")];
    document.body.innerHTML = '<div id="root"></div>';
    h = makeHost(svc);
    currentHost = h.host;
    await import("./main.ts");
    await settle();
    expect(text(document.querySelector("#root")!)).toContain("entry-test");
    expect(findButton(document.body, "Add account")).toBeTruthy();
  });
});
