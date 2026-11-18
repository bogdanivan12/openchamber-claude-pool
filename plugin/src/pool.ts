import { mkdirSync, watch } from "node:fs";
import { enabledAccounts, type AccountsFile } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { POOL_PROVIDER_ID } from "./constants.js";

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
  mkdirSync(dataDir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dataDir, (_event, name) => {
    if (name && name !== "accounts.json") return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });
  watcher.unref?.();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
