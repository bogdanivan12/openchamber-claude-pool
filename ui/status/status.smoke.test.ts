import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createStatus } from "./app.ts";
import { account, FakeService, installDom, makeHost, settle, text, uninstallDom } from "../panel/test-helpers.ts";

const NOW = Date.now();
mock.module("@openchamber/sdk", () => ({ connectHost: () => ({}) }));

beforeAll(installDom);
afterAll(uninstallDom);

let svc: FakeService;
let root: HTMLElement;
let h: ReturnType<typeof makeHost>;
let heights: number[];

beforeEach(() => {
  svc = new FakeService();
  heights = [];
});

const usage = (five: number, seven: number) => ({
  windows: {
    five_hour: { usedPercent: five, resetsAt: NOW + 3600_000, updatedAt: NOW },
    seven_day: { usedPercent: seven, resetsAt: NOW + 86400_000, updatedAt: NOW },
  },
  limitedUntil: null, needsLogin: false,
});

function mount(setHeight?: (h: number) => Promise<unknown>) {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.querySelector("#root") as HTMLElement;
  h = makeHost(svc);
  const host = { ...h.host, setHeight: setHeight ?? (async (n: number) => { heights.push(n); }) };
  createStatus(host as never, root);
}
const rows = () => Array.from(root.querySelectorAll(".row"));

describe("status section smoke test (happy-dom, fake service)", () => {
  it("shows a loading placeholder, then one row per enabled account", async () => {
    svc.accounts = [account("a1", "work", { state: usage(40, 10) }), account("a2", "home", { enabled: false }), account("a3", "side")];
    mount();
    expect(text(root)).toContain("Loading…");
    await settle();
    expect(text(root)).not.toContain("Loading…");
    expect(rows().length).toBe(2);
    expect(text(root)).toContain("work");
    expect(text(root)).toContain("side");
    expect(text(root)).not.toContain("home");
  });

  it("marks the pool-active account and shows the 5h bar and both windows", async () => {
    svc.accounts = [account("a1", "work", { poolActive: true, state: usage(72, 10) }), account("a2", "side", { state: usage(5, 6) })];
    mount();
    await settle();
    const [first, second] = rows();
    expect(first.textContent).toContain("● work");
    expect(first.querySelector(".active")?.textContent).toContain("work");
    expect(second.textContent).not.toContain("●");
    expect(first.textContent).toContain("5h 72% · 7d 10%");
    const bar = first.querySelector('[role="progressbar"]') as HTMLElement | null;
    expect(bar?.getAttribute("aria-valuenow")).toBe("72");
  });

  it("shows sign in again for needsLogin and the time left when limited", async () => {
    svc.accounts = [
      account("a1", "work", { state: { windows: {}, limitedUntil: null, needsLogin: true } }),
      account("a2", "home", { state: { windows: {}, limitedUntil: Date.now() + 90 * 60_000, needsLogin: false } }),
    ];
    mount();
    await settle();
    const [a, b] = rows();
    expect(a.textContent).toContain("sign in again");
    expect(a.querySelector(".error")).not.toBeNull();
    expect(b.textContent).toMatch(/limited · 1h 3\dm|limited · 1h 30m|limited · 1h 29m/);
    expect(b.querySelector(".warning")).not.toBeNull();
  });

  it("says when the Claude Code CLI is missing", async () => {
    svc.cliFound = false;
    svc.accounts = [account("a1", "work")];
    mount();
    await settle();
    expect(text(root)).toContain("Claude Code CLI not found");
    expect(rows().length).toBe(0);
  });

  it("says when there are no accounts", async () => {
    mount();
    await settle();
    expect(text(root)).toContain("No accounts. Open the Claude Pool panel to add one.");
  });

  it("shows one friendly line when the service fails", async () => {
    svc.reject = Object.assign(new Error("NO_SERVICE"), { code: "NO_SERVICE" });
    mount();
    await settle();
    expect(text(root)).toContain("not approved or not running");
    expect(text(root)).not.toContain("at ");
  });

  it("refreshes from the ↻ button", async () => {
    svc.accounts = [account("a1", "work", { state: usage(1, 1) })];
    mount();
    await settle();
    expect(svc.find("GET", "/api/accounts").length).toBe(1);
    svc.accounts = [account("a1", "work", { state: usage(50, 1) })];
    const btn = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === "↻") as HTMLButtonElement;
    btn.click();
    await settle();
    expect(svc.find("GET", "/api/accounts").length).toBe(2);
    expect(text(root)).toContain("5h 50%");
    expect(rows().length).toBe(1);
  });

  it("reports its height after rendering, and survives a rejecting setHeight", async () => {
    svc.accounts = [account("a1", "work")];
    mount();
    await settle();
    expect(heights.length).toBeGreaterThan(0);
    mount(async () => { throw new Error("no"); });
    await settle();
    expect(rows().length).toBe(1);
    document.body.innerHTML = '<div id="root"></div>';
    root = document.querySelector("#root") as HTMLElement;
    createStatus({ ...h.host } as never, root); // no setHeight at all
    await settle();
    expect(rows().length).toBe(1);
  });

  it("does not mount twice when the host says ready again; it just refreshes", async () => {
    svc.accounts = [account("a1", "work")];
    mount();
    await settle();
    h.ready();
    await settle();
    expect(svc.find("GET", "/api/accounts").length).toBe(2);
    expect(rows().length).toBe(1);
    expect(root.querySelectorAll("button").length).toBe(1);
  });
});
