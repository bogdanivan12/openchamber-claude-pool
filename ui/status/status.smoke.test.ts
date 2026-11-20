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
  h = makeHost(svc, { asyncReady: true });
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
    expect(first.querySelector(".dot")?.className).toContain("use");
    expect(first.querySelector(".dot")?.getAttribute("title")).toBe("In use now");
    expect(first.querySelector(".active")?.textContent).toContain("work");
    expect(second.querySelector(".dot")?.className).toContain("ready");
    expect(second.querySelector(".dot")?.getAttribute("title")).toBe("Available");
    const [five, seven] = Array.from(first.querySelectorAll(".win"));
    expect(five.textContent).toContain("5-Hour");
    expect(five.querySelector(".pct")?.textContent).toBe("72%");
    expect(seven.textContent).toContain("7-Day Limit");
    expect(seven.querySelector(".pct")?.textContent).toBe("10%");
    expect(five.querySelector(".pct-warning")).not.toBeNull();
    expect(seven.querySelector(".pct-warning, .pct-error")).toBeNull();
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
    expect(b.textContent).toMatch(/^.*limited · 1h (29|30)m$/);
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
    expect(text(root)).toContain("50%");
    expect(rows().length).toBe(1);
  });

  it("reports the content height, rounded up, and can shrink", async () => {
    svc.accounts = [account("a1", "work")];
    let h1 = 50.2;
    document.body.innerHTML = '<div id="root"></div>';
    root = document.querySelector("#root") as HTMLElement;
    root.getBoundingClientRect = () => ({ height: h1 }) as DOMRect;
    h = makeHost(svc, { asyncReady: true });
    createStatus({ ...h.host, setHeight: async (n: number) => { heights.push(n); } } as never, root);
    await settle();
    expect(heights.at(-1)).toBe(51);
    h1 = 30.5;
    h.ready();
    await settle();
    expect(heights.at(-1)).toBe(31);
    h1 = 2;
    h.ready();
    await settle();
    expect(heights.at(-1)).toBe(24);
  });

  it("survives a rejecting setHeight", async () => {
    svc.accounts = [account("a1", "work")];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    mount(async () => { throw new Error("no"); });
    await settle();
    expect(rows().length).toBe(1);
    expect(text(root)).toContain("work");
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("survives a throwing or missing setHeight", async () => {
    svc.accounts = [account("a1", "work")];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    document.body.innerHTML = '<div id="root"></div>';
    root = document.querySelector("#root") as HTMLElement;
    h = makeHost(svc, { asyncReady: true });
    createStatus({ ...h.host, setHeight: () => { throw new Error("sync"); } } as never, root);
    await settle();
    expect(text(root)).toContain("work");
    document.body.innerHTML = '<div id="root"></div>';
    root = document.querySelector("#root") as HTMLElement;
    h = makeHost(svc, { asyncReady: true });
    createStatus({ ...h.host } as never, root);
    await settle();
    expect(text(root)).toContain("work");
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("loads exactly once per ready and never duplicates the DOM", async () => {
    svc.accounts = [account("a1", "work")];
    mount();
    await settle();
    expect(svc.find("GET", "/api/accounts").length).toBe(1);
    h.ready();
    await settle();
    expect(svc.find("GET", "/api/accounts").length).toBe(2);
    expect(rows().length).toBe(1);
    expect(root.querySelectorAll("button").length).toBe(1);
  });

  describe("overlapping loads", () => {
    type Pending = { resolve: (body: unknown) => void; reject: (e: Error) => void };
    function controlled() {
      const pending: Pending[] = [];
      document.body.innerHTML = '<div id="root"></div>';
      root = document.querySelector("#root") as HTMLElement;
      h = makeHost(svc, { asyncReady: true });
      const host = {
        ...h.host,
        serviceRequest: () => new Promise<{ status: number; body: string }>((res, rej) => {
          pending.push({ resolve: (b) => res({ status: 200, body: JSON.stringify(b) }), reject: rej });
        }),
        setHeight: async () => {},
      };
      createStatus(host as never, root);
      const list = (name: string) => ({ accounts: [account(name, name)], recoveredBackup: false, cliFound: true });
      return { pending, list };
    }
    const refreshBtn = () => Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === "↻") as HTMLButtonElement;

    it("drops a stale slow answer and lets the newest decide the button", async () => {
      const { pending, list } = controlled();
      await settle();
      expect(pending.length).toBe(1);
      expect(refreshBtn().disabled).toBe(true);
      h.ready(); // second load while the first is in flight
      await settle();
      expect(pending.length).toBe(2);
      pending[1].resolve(list("second"));
      await settle();
      expect(text(root)).toContain("second");
      expect(refreshBtn().disabled).toBe(false);
      pending[0].resolve(list("first"));
      await settle();
      expect(text(root)).toContain("second");
      expect(text(root)).not.toContain("first");
      expect(refreshBtn().disabled).toBe(false);
    });

    it("drops an outdated error", async () => {
      const { pending, list } = controlled();
      await settle();
      h.ready();
      await settle();
      pending[1].resolve(list("second"));
      await settle();
      pending[0].reject(new Error("late failure"));
      await settle();
      expect(text(root)).toContain("second");
      expect(text(root)).not.toContain("late failure");
    });

    it("keeps the button disabled while the newest load is still running", async () => {
      const { pending, list } = controlled();
      await settle();
      h.ready();
      await settle();
      pending[0].resolve(list("first"));
      await settle();
      expect(text(root)).not.toContain("first");
      expect(refreshBtn().disabled).toBe(true);
      pending[1].resolve(list("second"));
      await settle();
      expect(refreshBtn().disabled).toBe(false);
    });
  });

  it("gives a long service error a title with the full text", async () => {
    svc.reject = new Error("x".repeat(300));
    mount();
    await settle();
    const l = root.querySelector(".line.error, .line") as HTMLElement;
    expect(l.getAttribute("title")).toBe("x".repeat(300));
  });
});
