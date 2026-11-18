import { readQuotaProviderRequest } from "@openchamber/sdk";
import { enabledAccounts, readAccounts } from "../../shared/accounts.ts";
import { poolDataDir } from "../../shared/paths.ts";
import { readState } from "../../shared/state.ts";
import type { Route } from "./http.ts";
import { buildQuotaAnswer } from "./quota.ts";
import { refreshAllUsage, type UsageDeps } from "./usage.ts";

export function quotaRoute(deps: UsageDeps & { dataDir?: string } = {}): Route {
  const { dataDir = poolDataDir(), ...usageDeps } = deps;
  return async (r) => {
    if (!readQuotaProviderRequest(r.body)) return { status: 400, body: { error: "not a usage call this service understands" } };
    const reads = await refreshAllUsage(dataDir, usageDeps);
    const file = readAccounts(dataDir);
    const data = buildQuotaAnswer({ accounts: enabledAccounts(file), state: readState(dataDir), threshold: file.threshold, now: (usageDeps.now ?? Date.now)(), reads });
    return { status: 200, body: { ok: true, data } };
  };
}
