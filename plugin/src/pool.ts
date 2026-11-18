import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { enabledAccounts, type AccountsFile } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { POOL_PROVIDER_ID } from "./constants.js";
import { log } from "./log.js";

export type PoolProviderSpec = { id: string; name: string };

export const accountProviderId = (id: string): string => `${POOL_PROVIDER_ID}-${id}`;

export function accountFromProviderId(providerID: string): "pool" | string | null {
  if (providerID === POOL_PROVIDER_ID) return "pool";
  const m = /^claude-pool-([0-9a-f]{6})$/.exec(providerID);
  return m ? m[1] : null;
}

export function poolProviderSpecs(file: AccountsFile): PoolProviderSpec[] {
  const enabled = enabledAccounts(file);
  if (enabled.length === 0) return [];
  return [
    { id: POOL_PROVIDER_ID, name: "Claude Pool" },
    ...enabled.map((a) => ({ id: accountProviderId(a.id), name: `Claude · ${a.label}` })),
  ];
}

/** Event-driven: fires (debounced) when accounts.json is replaced. No polling. */
export function watchAccounts(onChange: () => void, dataDir: string = poolDataDir()): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;
  try {
    mkdirSync(dataDir, { recursive: true });
    watcher = watch(dataDir, (_event, name) => {
      if (name && name !== "accounts.json") return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 300);
      timer.unref?.();
    });
  } catch (err) {
    log.warn("[claude-pool] could not watch accounts.json; provider changes need a plugin reload", err instanceof Error ? err.message : err);
    return () => {};
  }
  watcher.unref?.();
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    try {
      watcher.close();
    } catch {}
  };
  watcher.on("error", (err) => {
    log.warn("[claude-pool] accounts.json watcher failed; provider changes need a plugin reload", err instanceof Error ? err.message : err);
    stop();
  });
  return stop;
}

const SESSION_PROVIDER_CAP = 500;
const sessionProviders = new Map<string, string>();

/** Module-level on purpose: the fallback handler is a process-wide singleton. */
export function rememberSessionProvider(sessionID: string, providerID: string): void {
  sessionProviders.delete(sessionID);
  sessionProviders.set(sessionID, providerID);
  if (sessionProviders.size > SESSION_PROVIDER_CAP) {
    const oldest = sessionProviders.keys().next().value;
    if (oldest !== undefined) sessionProviders.delete(oldest);
  }
}

export function providerForSession(sessionID: string): string | undefined {
  return sessionProviders.get(sessionID);
}
