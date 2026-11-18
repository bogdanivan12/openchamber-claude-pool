import { readQuotaProviderRequest } from "@openchamber/sdk";
import { enabledAccounts, readAccounts } from "../../shared/accounts.ts";
import { readState } from "../../shared/state.ts";
import { buildQuotaAnswer } from "./quota.ts";
import { refreshAllUsage } from "./usage.ts";
import type { Route } from "./http.ts";

/** Mutable on purpose: later modules register their routes into this table. */
export const routes: Record<string, Route> = {
  "GET /health": () => ({ status: 200, body: { ok: true } }),
};

routes["POST /quota"] = async (r) => {
  if (!readQuotaProviderRequest(r.body)) return { status: 400, body: { error: "not a usage call this service understands" } };
  const reads = await refreshAllUsage();
  const file = readAccounts();
  const data = buildQuotaAnswer({ accounts: enabledAccounts(file), state: readState(), threshold: file.threshold, now: Date.now(), reads });
  return { status: 200, body: { ok: true, data } };
};
