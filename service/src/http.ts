import http from "node:http";

export type RouteRequest = { method: string; path: string; query: URLSearchParams; body: string };
export type RouteResult = { status: number; body: unknown };
export type Route = (req: RouteRequest) => Promise<RouteResult> | RouteResult;

const MAX_BODY_BYTES = 1024 * 1024;

function match(routes: Record<string, Route>, method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const [key, route] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const a = pattern.split("/"), b = path.split("/");
    if (a.length !== b.length) continue;
    const params: Record<string, string> = {};
    if (a.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) {
      return { route, params };
    }
  }
  return null;
}

export function createServer(routes: Record<string, Route>, token: string): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
    let url: URL;
    let found: ReturnType<typeof match>;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
      found = match(routes, req.method ?? "GET", url.pathname);
    } catch {
      return send(400, { error: "bad-request" });
    }
    if (!found) return send(404, { error: "not-found" });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        send(413, { error: "payload-too-large" }, { connection: "close" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString("utf8");
      for (const [k, v] of Object.entries(found.params)) url.searchParams.set(k, v);
      try {
        const out = await found.route({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
        send(out.status, out.body);
      } catch (err) {
        if (err instanceof SyntaxError) return send(400, { error: "invalid-json" });
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}
