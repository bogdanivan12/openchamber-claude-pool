import type { AccountView } from "./format.ts";

export type Host = { serviceRequest(r: { method: string; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> };

export type LoginView =
  | { state: "idle" }
  | { state: "awaiting-code"; url: string; accountId: string; label: string }
  | { state: "verifying" }
  | { state: "succeeded"; account: AccountView | { id: string; label: string }; duplicateOf: string | null; emailChanged?: { from: string; to: string }; warning?: string }
  | { state: "failed"; message: string };

/** An error field from the service, as text. Never "[object Object]". */
export function errorText(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/** Turns a rejected `serviceRequest` (host error code or text) into something a person can act on. */
export function classifyRequestError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : errorText(e);
  const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : "";
  const has = (...names: string[]) => names.some((n) => code === n || raw.includes(n));
  if (has("NO_SERVICE", "NO_INTEGRATION", "DISABLED", "NOT_GRANTED")) {
    return new Error(`The Claude Pool service is not approved or not running. Re-approve the extension in Settings → Extensions. (${raw})`);
  }
  if (has("SERVICE_FAILED", "DISCONNECTED", "HOST_TIMEOUT", "HOST_UNAVAILABLE")) {
    return new Error(`The Claude Pool service stopped; try again. (${raw})`);
  }
  return new Error(raw);
}

async function call<T>(host: Host, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  let res: { status: number; body: string };
  try {
    res = await host.serviceRequest({ method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw classifyRequestError(e);
  }
  let parsed: any = {};
  try { parsed = res.body ? JSON.parse(res.body) : {}; } catch { if (res.status < 400) throw new Error("The service sent an unreadable answer."); }
  if (res.status >= 400) throw new Error(parsed?.error !== undefined ? errorText(parsed.error) : `HTTP ${res.status}`);
  return parsed as T;
}

const id = encodeURIComponent;

export const api = (host: Host) => ({
  list: () => call<{ accounts: AccountView[]; recoveredBackup: boolean; cliFound: boolean }>(host, "GET", "/api/accounts"),
  candidates: () => call<{ candidates: string[] }>(host, "GET", "/api/import-candidates"),
  import: (configDirs: string[]) => call<{ added: unknown[]; skipped: { configDir: string; reason: string }[] }>(host, "POST", "/api/import", { configDirs }),
  patch: (accountId: string, p: { label?: string; enabled?: boolean }) => call<unknown>(host, "PATCH", `/api/accounts/${id(accountId)}`, p),
  reorder: (ids: string[]) => call<unknown>(host, "POST", "/api/accounts/reorder", { ids }),
  remove: (accountId: string, deleteLogin: boolean) => call<{ ok: boolean; deletedLogin: boolean; warning?: string }>(host, "DELETE", `/api/accounts/${id(accountId)}`, undefined, deleteLogin ? { deleteLogin: "1" } : undefined),
  ackBackup: () => call<{ ok: true }>(host, "POST", "/api/accounts/ack-backup"),
  loginStart: (p: { label: string } | { accountId: string }) => call<LoginView>(host, "POST", "/api/login/start", p),
  loginCode: (code: string) => call<LoginView>(host, "POST", "/api/login/code", { code }),
  loginCancel: () => call<unknown>(host, "POST", "/api/login/cancel"),
  login: () => call<LoginView>(host, "GET", "/api/login"),
});

export type Client = ReturnType<typeof api>;
