/** Test-only: a headless DOM (happy-dom, installed per test file and removed after) and an in-memory fake of the Claude Pool service. */
import { Window } from "happy-dom";
import type { LoginView } from "../shared/api.ts";
import type { AccountView } from "../shared/format.ts";
import type { PanelHost } from "./ctx.ts";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLLabelElement", "HTMLStyleElement", "SVGElement", "DocumentFragment", "CustomEvent", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "CSS"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

export function installDom(): void {
  const win = new Window({ url: "http://localhost/" });
  for (const name of GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = name === "window" ? win : (win as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

export function uninstallDom(): void {
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  saved.clear();
}

/** Lets every pending promise chain run (the fake service and the injected sleep never use real timers). */
export const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

export const text = (root: Element) => root.textContent ?? "";
export const findButton = (root: Element, label: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
export const buttonLabels = (root: Element) => Array.from(root.querySelectorAll("button")).map((b) => b.textContent?.trim() ?? "");

export async function click(root: Element, label: string): Promise<void> {
  const b = findButton(root, label);
  if (!b) throw new Error(`No button "${label}". Buttons: ${buttonLabels(root).join(", ")}`);
  b.click();
  await settle();
}

/** Types into the text field whose caption contains `caption`. */
export async function typeInto(root: Element, caption: string, value: string): Promise<void> {
  const field = Array.from(root.querySelectorAll("label")).find((l) => l.textContent?.includes(caption));
  const input = field?.querySelector("input,textarea") as HTMLInputElement | null | undefined;
  if (!input) throw new Error(`No field "${caption}"`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

export const fieldNote = (root: Element, caption: string) => {
  const field = Array.from(root.querySelectorAll("label")).find((l) => l.textContent?.includes(caption));
  const note = field?.querySelector(".oc-sdk-field-note") as HTMLElement | null | undefined;
  return note && !note.hidden ? note.textContent ?? "" : "";
};

export type Req = { method: string; path: string; query?: Record<string, string>; body?: any };

export const account = (id: string, label: string, extra: Partial<AccountView> = {}): AccountView => ({
  id, label, configDir: `/pool/${id}`, order: 0, enabled: true, state: null, poolActive: false, canDeleteLogin: false, ...extra,
});

/** Implements the service API contract in memory. Tests poke its fields to set up scenarios. */
export class FakeService {
  accounts: AccountView[] = [];
  threshold = 90;
  recoveredBackup = false;
  cliFound = true;
  candidates: string[] = [];
  skipped: { configDir: string; reason: string }[] = [];
  login: LoginView = { state: "idle" };
  /** The login state as a plain string (the union narrows after assignments). */
  get loginState(): string { return this.login.state; }
  /** What a code does. Default: "good" signs in a new account, anything else fails. */
  duplicateOf: string | null = null;
  /** While the login is verifying, GET /api/login answers verifying this many more times, then `onVerified` runs. */
  verifyingLeft = 0;
  onVerified: () => void = () => {};
  reject: Error | null = null;
  requests: Req[] = [];

  async serviceRequest(r: { method: string; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    const req: Req = { method: r.method, path: r.path, ...(r.query ? { query: r.query } : {}), ...(r.body ? { body: JSON.parse(r.body) } : {}) };
    this.requests.push(req);
    if (this.reject) throw this.reject;
    const out = this.handle(req);
    return { status: out.status ?? 200, body: JSON.stringify(out.json) };
  }

  find(method: string, path: string) { return this.requests.filter((q) => q.method === method && q.path === path); }

  private handle(q: Req): { status?: number; json: unknown } {
    const { method, path, body } = q;
    const err = (error: string, status = 400) => ({ status, json: { error } });
    const idMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (method === "GET" && path === "/api/accounts") return { json: { accounts: this.accounts, threshold: this.threshold, recoveredBackup: this.recoveredBackup, cliFound: this.cliFound } };
    if (method === "GET" && path === "/api/import-candidates") return { json: { candidates: this.candidates } };
    if (method === "POST" && path === "/api/import") {
      const skippedDirs = new Set(this.skipped.map((s) => s.configDir));
      const added = (body.configDirs as string[]).filter((d) => !skippedDirs.has(d));
      for (const d of added) this.accounts.push(account(`imp${this.accounts.length}`, d.split("/").pop() ?? d, { configDir: d }));
      return { json: { added, skipped: this.skipped.filter((s) => body.configDirs.includes(s.configDir)) } };
    }
    if (method === "PATCH" && idMatch) {
      const a = this.accounts.find((x) => x.id === decodeURIComponent(idMatch[1]));
      if (!a) return err("No such account", 404);
      if (body.label !== undefined && this.accounts.some((x) => x !== a && x.label.toLowerCase() === body.label.toLowerCase())) return err(`There is already an account called "${body.label}".`);
      Object.assign(a, body);
      return { json: a };
    }
    if (method === "POST" && path === "/api/accounts/reorder") {
      this.accounts = (body.ids as string[]).map((id) => this.accounts.find((a) => a.id === id)!);
      return { json: { ok: true } };
    }
    if (method === "DELETE" && idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (!this.accounts.some((a) => a.id === id)) return err("No such account", 404);
      this.accounts = this.accounts.filter((a) => a.id !== id);
      return { json: { ok: true, deletedLogin: q.query?.deleteLogin === "1" } };
    }
    if (method === "PUT" && path === "/api/settings") {
      const t = body.threshold;
      if (!Number.isInteger(t) || t < 50 || t > 100) return err("threshold must be an integer from 50 to 100");
      this.threshold = t;
      return { json: { ok: true } };
    }
    if (method === "POST" && path === "/api/accounts/ack-backup") { this.recoveredBackup = false; return { json: { ok: true } }; }
    if (method === "GET" && path === "/api/login") {
      if (this.login.state === "verifying") {
        if (this.verifyingLeft > 0) this.verifyingLeft--;
        else this.onVerified();
      }
      return { json: this.login };
    }
    if (method === "POST" && path === "/api/login/start") {
      if (body.label !== undefined && this.accounts.some((a) => a.label.toLowerCase() === body.label.toLowerCase())) return err("That name is already used.");
      const existing = body.accountId ? this.accounts.find((a) => a.id === body.accountId) : undefined;
      this.login = { state: "awaiting-code", url: "https://claude.test/oauth/authorize", accountId: existing?.id ?? "newacct", label: existing?.label ?? body.label };
      return { json: this.login };
    }
    if (method === "POST" && path === "/api/login/code") {
      if (this.login.state !== "awaiting-code") return err("No sign-in in progress", 409);
      if (body.code !== "good") { this.login = { state: "failed", message: "That code was not accepted." }; return { json: this.login }; }
      const created = account(this.login.accountId, this.login.label);
      if (!this.accounts.some((a) => a.id === created.id)) this.accounts.push(created);
      this.login = { state: "succeeded", account: created, duplicateOf: this.duplicateOf };
      return { json: this.login };
    }
    if (method === "POST" && path === "/api/login/cancel") { this.login = { state: "idle" }; return { json: { ok: true } }; }
    return err(`Unhandled ${method} ${path}`, 404);
  }
}

export type Mounted = { root: HTMLElement; host: PanelHost; opened: string[]; ready: (directory?: string | null) => void };

/** A fake host. `onReady` calls the listener at once; `ready()` fires it again later. */
export function makeHost(service: FakeService, opts: { asyncReady?: boolean } = {}): { host: PanelHost; opened: string[]; ready: (directory?: string | null) => void; openUrlError: { value: Error | null } } {
  const opened: string[] = [];
  const openUrlError = { value: null as Error | null };
  let listener: ((c: any) => void) | null = null;
  const context = (directory: string | null) => ({
    theme: { mode: "dark", tokens: new Proxy({}, { get: () => "#222" }) },
    surface: "panel", locale: "en", directory, session: null,
  });
  const host: PanelHost = {
    serviceRequest: (r) => service.serviceRequest(r),
    openUrl: async (u: string) => { if (openUrlError.value) throw openUrlError.value; opened.push(u); },
    onReady: (cb) => {
      listener = cb;
      if (opts.asyncReady) queueMicrotask(() => cb(context("/project/a") as never));
      else cb(context("/project/a") as never);
      return () => {};
    },
  };
  return { host, opened, ready: (d = "/project/a") => listener?.(context(d)), openUrlError };
}
