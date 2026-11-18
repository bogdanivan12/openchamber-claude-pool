import { quotaRoute } from "./quota-route.ts";
import type { Route } from "./http.ts";

/** Mutable on purpose: later modules register their routes into this table. */
export const routes: Record<string, Route> = {
  "GET /health": () => ({ status: 200, body: { ok: true } }),
};

routes["POST /quota"] = quotaRoute();
