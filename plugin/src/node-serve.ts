import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/** The slice of Bun.serve's return value the proxy uses. */
export type ProxyServer = {
  port: number | undefined;
  stop(closeActiveConnections?: boolean): void;
};

export type ServeOptions = {
  hostname: string;
  port: number;
  /** Seconds; 0 disables the idle timeout (Bun semantics). */
  idleTimeout: number;
  fetch(req: Request): Response | Promise<Response>;
};

/**
 * Bun.serve when running under Bun; otherwise a node:http adapter with the same
 * fetch-handler contract. OpenChamber's built-in OpenCode runs on Node/Electron,
 * where the `Bun` global does not exist.
 */
export async function serve(options: ServeOptions): Promise<ProxyServer> {
  const bun = (globalThis as { Bun?: { serve(o: unknown): ProxyServer } }).Bun;
  if (bun && typeof bun.serve === "function") {
    return bun.serve({
      hostname: options.hostname,
      port: options.port,
      idleTimeout: options.idleTimeout,
      fetch: options.fetch,
    });
  }
  return serveWithNode(options);
}

function serveWithNode(options: ServeOptions): Promise<ProxyServer> {
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const controller = new AbortController();
    nodeRes.on("close", () => {
      if (!nodeRes.writableFinished) controller.abort();
    });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(nodeReq.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else headers.set(name, value);
      }
      const method = nodeReq.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
      if (hasBody) {
        init.body = Readable.toWeb(nodeReq) as unknown as ReadableStream;
        init.duplex = "half";
      }
      const host = nodeReq.headers.host ?? `${options.hostname}:${options.port}`;
      const response = await options.fetch(new Request(`http://${host}${nodeReq.url ?? "/"}`, init));

      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
      if (cookies && cookies.length > 0) out["set-cookie"] = cookies;
      nodeRes.writeHead(response.status, out);

      if (!response.body) {
        nodeRes.end();
        return;
      }
      const reader = response.body.getReader();
      nodeRes.on("close", () => {
        void reader.cancel().catch(() => {});
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (nodeRes.destroyed) break;
        if (!nodeRes.write(value)) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              nodeRes.off("drain", finish);
              nodeRes.off("close", finish);
              resolve();
            };
            nodeRes.on("drain", finish);
            nodeRes.on("close", finish);
          });
        }
      }
      nodeRes.end();
    } catch (err) {
      if (nodeRes.headersSent) {
        nodeRes.destroy(err instanceof Error ? err : undefined);
        return;
      }
      nodeRes.writeHead(500, { "content-type": "text/plain" });
      nodeRes.end(err instanceof Error ? err.message : "Internal Server Error");
    }
  });

  // Long-lived streaming responses: never time out on idle.
  server.requestTimeout = 0;
  server.timeout = options.idleTimeout * 1000;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      resolve({
        get port() {
          return (server.address() as AddressInfo | null)?.port;
        },
        stop(closeActiveConnections = true) {
          server.close();
          if (closeActiveConnections) server.closeAllConnections();
          else server.closeIdleConnections();
        },
      });
    });
  });
}
