import type { AccountView } from "./format.ts";

export type Host = { serviceRequest(r: { method: string; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> };

export type LoginView =
  | { state: "idle" }
  | { state: "awaiting-code"; url: string; accountId: string; label: string }
  | { state: "verifying" }
  | { state: "succeeded"; account: AccountView | { id: string; label: string }; duplicateOf: string | null; emailChanged?: { from: string; to: string }; warning?: string }
  | { state: "failed"; message: string };

async function call<T>(host: Host, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const res = await host.serviceRequest({ method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let parsed: any = {};
  try { parsed = res.body ? JSON.parse(res.body) : {}; } catch { if (res.status < 400) throw new Error("The service sent an unreadable answer."); }
  if (res.status >= 400) throw new Error(parsed?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

export const api = (host: Host) => ({
  list: () => call<{ accounts: AccountView[]; threshold: number; recoveredBackup: boolean; cliFound: boolean }>(host, "GET", "/api/accounts"),
  candidates: () => call<{ candidates: string[] }>(host, "GET", "/api/import-candidates"),
  import: (configDirs: string[]) => call<{ added: unknown[]; skipped: { configDir: string; reason: string }[] }>(host, "POST", "/api/import", { configDirs }),
  patch: (id: string, p: { label?: string; enabled?: boolean }) => call<unknown>(host, "PATCH", `/api/accounts/${id}`, p),
  reorder: (ids: string[]) => call<unknown>(host, "POST", "/api/accounts/reorder", { ids }),
  remove: (id: string, deleteLogin: boolean) => call<{ ok: boolean; deletedLogin: boolean; warning?: string }>(host, "DELETE", `/api/accounts/${id}`, undefined, deleteLogin ? { deleteLogin: "1" } : undefined),
  setThreshold: (threshold: number) => call<unknown>(host, "PUT", "/api/settings", { threshold }),
  ackBackup: () => call<{ ok: true }>(host, "POST", "/api/accounts/ack-backup"),
  loginStart: (p: { label: string } | { accountId: string }) => call<LoginView>(host, "POST", "/api/login/start", p),
  loginCode: (code: string) => call<LoginView>(host, "POST", "/api/login/code", { code }),
  loginCancel: () => call<unknown>(host, "POST", "/api/login/cancel"),
  login: () => call<LoginView>(host, "GET", "/api/login"),
});

export type Client = ReturnType<typeof api>;
