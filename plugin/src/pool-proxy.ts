import { enabledAccounts, readAccounts, type Account } from "../../shared/accounts.ts";
import { defaultConfigDir, isDefaultConfigDir, poolDataDir } from "../../shared/paths.ts";
import { route } from "../../shared/router.ts";
import { bindConversation, markLimited, readState, updateState } from "../../shared/state.ts";
import { findBridgeByConversation } from "./bridge-pool.js";
import { ACCOUNT_HEADER, CONFIG_DIR_HEADER, KIND_HEADER, SESSION_HEADER } from "./constants.js";
import { log } from "./log.js";

export type ChatHandler = (req: Request, body: any) => Promise<Response>;

type MigrationHook = (sessionKey: string, fromDir: string, toDir: string) => void;
let migrationHook: MigrationHook | null = null;
export function setMigrationHook(fn: MigrationHook | null): void {
  migrationHook = fn;
}

/** The default dir runs without CLAUDE_CONFIG_DIR, so it keeps its own Keychain item. */
export function withAccountDir(req: Request, configDir: string): Request {
  const headers = new Headers(req.headers);
  if (isDefaultConfigDir(configDir)) headers.delete(CONFIG_DIR_HEADER);
  else headers.set(CONFIG_DIR_HEADER, encodeURIComponent(configDir));
  return new Request(req.url, { method: req.method, headers });
}

export async function limitFromResponse(res: Response): Promise<{ until: number } | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as any;
    if (body?.error?.code !== "claude_session_limit") return null;
    const resetsAt = body.error.resets_at ? Date.parse(body.error.resets_at) : NaN;
    const retryAfter = Number(body.error.retry_after ?? res.headers.get("retry-after"));
    const until = Number.isFinite(resetsAt)
      ? resetsAt
      : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600_000);
    return { until };
  } catch {
    return null;
  }
}

export function poolLimitResponse(retryAt: number | null): Response {
  const seconds = retryAt === null ? 600 : Math.max(1, Math.round((retryAt - Date.now()) / 1000));
  const message =
    retryAt === null
      ? "Every Claude Pool account is limited or signed out. Sign in again in the Claude Pool panel."
      : `Every Claude Pool account is at its limit. The first one frees up at ${new Date(retryAt).toISOString()}.`;
  return Response.json(
    {
      error: {
        message,
        type: "rate_limit_error",
        code: "claude_session_limit",
        retry_after: seconds,
        ...(retryAt !== null ? { resets_at: new Date(retryAt).toISOString() } : {}),
      },
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

const badAccount = (id: string) =>
  Response.json(
    { error: { message: `Claude Pool account ${id} is not configured or is disabled. Open the Claude Pool panel.`, type: "invalid_request_error" } },
    { status: 400 },
  );

export async function handlePoolChat(req: Request, body: any, handle: ChatHandler, dataDir: string = poolDataDir()): Promise<Response> {
  const tag = req.headers.get(ACCOUNT_HEADER);
  if (!tag) return handle(req, body);

  const file = readAccounts(dataDir);
  const enabled = enabledAccounts(file);

  if (tag !== "pool") {
    const account = enabled.find((a) => a.id === tag);
    return account ? handle(withAccountDir(req, account.configDir), body) : badAccount(tag);
  }
  if (enabled.length === 0) return badAccount("pool");

  const sessionKey = req.headers.get(SESSION_HEADER) ?? undefined;

  // A turn parked on tool results continues on the account that started it.
  const parked = sessionKey ? findBridgeByConversation(sessionKey) : undefined;
  if (parked) {
    return handle(withAccountDir(req, parked.configDir ?? defaultConfigDir()), body);
  }

  const kind = req.headers.get(KIND_HEADER);
  const primary = !kind || kind === "primary";
  const tried = new Set<string>();
  let previous: Account | undefined;
  {
    const bound = sessionKey ? readState(dataDir).conversations[sessionKey]?.accountId : undefined;
    previous = bound ? enabled.find((a) => a.id === bound) : undefined;
  }

  // Titles, summaries and the like share the chat's session id but must not move it.
  if (!primary) {
    const st = previous ? readState(dataDir).accounts[previous.id] : undefined;
    if (previous && !st?.needsLogin && !((st?.limitedUntil ?? 0) > Date.now())) {
      return handle(withAccountDir(req, previous.configDir), body);
    }
  }

  for (let attempt = 0; attempt < enabled.length; attempt++) {
    const now = Date.now();
    const choice = route({ accounts: enabled, state: readState(dataDir), threshold: file.threshold, now, current: previous?.id, exclude: tried });
    if (choice.kind === "none") return poolLimitResponse(choice.retryAt);
    const account = choice.account;

    if (sessionKey && primary) {
      if (previous && previous.id !== account.id && migrationHook) {
        try {
          migrationHook(sessionKey, previous.configDir, account.configDir);
        } catch (err) {
          log.warn("[claude-pool] transcript migration failed; history will be replayed", err instanceof Error ? err.message : err);
        }
      }
      updateState((s) => bindConversation(s, sessionKey, account.id, now), dataDir);
    }

    const res = await handle(withAccountDir(req, account.configDir), body);
    const limit = await limitFromResponse(res);
    if (!limit) return res;

    log.info("[claude-pool] account hit its limit; trying the next one", { account: account.id });
    updateState((s) => markLimited(s, account.id, limit.until), dataDir);
    tried.add(account.id);
    previous = account;
  }
  const state = readState(dataDir);
  const route2 = route({ accounts: enabled, state, threshold: file.threshold, now: Date.now() });
  return poolLimitResponse(route2.kind === "none" ? route2.retryAt : null);
}
