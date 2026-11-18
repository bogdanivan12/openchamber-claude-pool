/**
 * OpenCode Claude Auth Plugin
 *
 * Enables Claude Code (subscription) inside OpenCode via:
 * 1. Local OpenAI-compatible proxy backed by the Claude Agent SDK
 * 2. Authentication owned entirely by the local Claude Code CLI
 * 3. Native effort variants, session resume, tools, skills, and MCP
 *
 * Register in opencode.json:
 *   { "plugins": ["@openchamber/opencode-claude"] }
 */
// Type-only: the v2 host loads a plain `{ id, setup }` object, so the plugin
// needs none of OpenCode's runtime packages.
import type { Model, Plugin, Provider } from "@opencode/plugin";
import { readAccounts } from "../../shared/accounts.ts";
import {
  ACCOUNT_HEADER,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  KIND_HEADER,
  OPENAI_COMPATIBLE_PACKAGE,
} from "./constants.js";
import { setPoolMode } from "./config-dir.js";
import { detectClaudeCode } from "./detect.js";
import { accountFromProviderId, poolProviderSpecs, providerForSession, rememberSessionProvider, watchAccounts, type PoolProviderSpec } from "./pool.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildEffortVariants,
  getClaudeModels,
  modelsFromSdk,
  setDiscoveredModels,
  type ClaudeModel,
  type SdkModelRow,
} from "./models.js";
import { listClaudeSupportedModels } from "./query.js";
import { closeSessionBridges } from "./bridge-pool.js";
import {
  getClaudeProxyBaseUrl,
  acquireProxy,
  releaseProxy,
  setModelFallbackHandler,
  startProxy,
} from "./proxy.js";

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
): void {
  // Header values must be Latin-1: fetch rejects a raw path like C:\项目.
  headers[DIRECTORY_HEADER] = encodeURIComponent(directory);
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}

type ProviderInfo = Provider.Info;
type ModelInfo = Model.Info;

/** OpenCode keeps this share of the window free before it compacts. */
const COMPACTION_RESERVE_SHARE = 0.15;

/**
 * The `compactAt` option: compact a chat at about this many tokens instead
 * of near a 1M window. OpenCode compacts when the prompt reaches its input
 * limit minus a reserve, so the input limit is set to put that point here.
 * The context window stays the model's own; only smaller models are left
 * alone.
 */
export function compactionInputLimit(model: ClaudeModel, compactAt: unknown): number | undefined {
  if (typeof compactAt !== "number" || !Number.isFinite(compactAt) || compactAt <= 0) return undefined;
  const input = Math.round(compactAt / (1 - COMPACTION_RESERVE_SHARE));
  return input < model.contextWindow ? input : undefined;
}

export function buildProviderModel(model: ClaudeModel, id: string, providerID: string, compactAt?: unknown): ModelInfo {
  const input = compactionInputLimit(model, compactAt);
  return {
    id,
    modelID: id,
    providerID,
    name: model.name,
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    // Effort travels in a header set by the model.request hook, so variants
    // carry no settings and OpenCode never sends reasoning_effort itself.
    variants: buildEffortVariants(model).map((effort) => ({ id: effort })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: model.contextWindow,
      // No input limit: OpenCode 2.0.19+ keeps 10% of the window free on
      // its own (compaction.buffer overrides it). A 900k input on top of
      // that compacted 1M chats at 81%, not the intended 90%.
      output: model.maxTokens,
      ...(input ? { input } : {}),
    },
  } as unknown as ModelInfo;
}

export function buildClaudeProviderModels(models: ClaudeModel[], providerID: string, compactAt?: unknown): ModelInfo[] {
  return models.map((model) => buildProviderModel(model, model.id, providerID, compactAt));
}

export function buildProviderInfo(baseURL: string, spec: PoolProviderSpec): ProviderInfo {
  return {
    id: spec.id,
    name: spec.name,
    // Accounts are managed by the Claude Pool extension, not an OpenCode credential.
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: { baseURL, provider: spec.id, apiKey: "claude-pool-proxy" },
  } as unknown as ProviderInfo;
}

// OpenCode starts a plugin instance per location and recycles idle ones, so
// setup runs many times a day; the account's model list rarely changes.
const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;
let lastModelRefresh = 0;

async function refreshModelCatalog(reload: () => Promise<void>) {
  const now = Date.now();
  if (now - lastModelRefresh < MODEL_REFRESH_INTERVAL_MS) return;
  lastModelRefresh = now;
  try {
    const rows = await listClaudeSupportedModels();
    if (!rows?.length) return;
    if (setDiscoveredModels(modelsFromSdk(rows as SdkModelRow[]))) {
      await reload();
    }
  } catch (err) {
    log.warn(
      "[opencode-claude] could not read the model list from Claude Code",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Close a session's parked turn as soon as OpenCode stops the session. A turn
 * parked on tool calls has no open HTTP request, so an abort never reaches the
 * proxy otherwise and the claude process lingered until the TTL reaper.
 */
function watchSessionInterrupts(ctx: Plugin.Context): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as { type?: string; data?: { sessionID?: string } };
        if (
          (e.type === "session.execution.interrupted" || e.type === "session.execution.failed") &&
          e.data?.sessionID
        ) {
          const closed = closeSessionBridges(e.data.sessionID);
          if (closed) {
            log.info("[opencode-claude] closed the parked turn of a stopped session", {
              sessionID: e.data.sessionID,
            });
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.warn(
          "[opencode-claude] session event stream ended",
          err instanceof Error ? err.message : err,
        );
      }
    }
  })();
  return () => controller.abort();
}

/** Registration-time URL; model.request replaces it with the live one. */
function currentProxyBaseUrl(): string {
  try {
    return getClaudeProxyBaseUrl();
  } catch {
    return "http://127.0.0.1:0/v1";
  }
}

/**
 * OpenCode v2 plugin that registers the Claude Pool provider and one provider
 * per enabled account in accounts.json. Sign-in is owned by the Claude CLI.
 */
export const ClaudeCodePlugin: Plugin.Plugin = {
  id: "claude-pool",
  async setup(ctx) {
    // `{ "package": "...", "options": { "debug": true } }` in opencode.json
    // turns on the durable debug log without touching the server's env.
    if ((ctx.options as { debug?: unknown } | undefined)?.debug === true) {
      process.env.OPENCODE_CLAUDE_DEBUG ??= "1";
    }
    setPoolMode(true);
    const directory = ctx.location.directory;
    // Bind first (ephemeral port by default) so the provider points at the
    // live listener for this process.
    try {
      await acquireProxy();
    } catch (err) {
      log.error(
        "[opencode-claude] proxy failed to start",
        err instanceof Error ? err.message : err,
      );
    }
    // The provider and its hook go in before anything slow: until then the
    // models are missing from OpenCode's catalog, and a session stepping
    // during a plugin reload fails with "Model unavailable".
    await ctx.provider.transform((providers) => {
      const compactAt = (ctx.options as { compactAt?: unknown } | undefined)?.compactAt;
      for (const spec of poolProviderSpecs(readAccounts())) {
        providers.add({
          info: buildProviderInfo(currentProxyBaseUrl(), spec),
          models: buildClaudeProviderModels(getClaudeModels(), spec.id, compactAt),
        });
      }
    });

    await ctx.session.hook("model.request", async (request) => {
      const providerID = (request.model as { providerID: string }).providerID;
      const account = accountFromProviderId(providerID);
      if (account === null) return;
      // Start late if setup could not bind, and always point at the live
      // listener in case it rebound since the provider was registered.
      await startProxy();
      request.baseURL = getClaudeProxyBaseUrl();
      const selected = resolveClaudeModelSelection(request.model.id, request.model.variant);
      request.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
      request.headers[KIND_HEADER] = request.kind;
      request.headers[ACCOUNT_HEADER] = account;
      // The proxy runs in the long-lived OpenCode server process, whose cwd
      // is commonly not the project attached to this plugin instance. Carry
      // the project directory so Claude Code loads the right project files.
      applyClaudeRequestContextHeaders(request.headers, directory, request.sessionID);
      rememberSessionProvider(request.sessionID, providerID);
    });

    const cliPresent = await probeCliPresence();
    // Refresh the catalog from the CLI in the background; the cached or
    // fallback list serves until it lands.
    if (cliPresent) {
      void refreshModelCatalog(() => ctx.provider.reload());
    }

    const stopWatching = watchSessionInterrupts(ctx);
    // Claude Code already moved the session to its fallback model; move the
    // OpenCode session too so the picker and the next turns match it.
    setModelFallbackHandler((sessionID, modelId, variant) => {
      const providerID = providerForSession(sessionID);
      if (!providerID) {
        log.info("[claude-pool] unknown session for model fallback; not switching");
        return;
      }
      void ctx.session
        .switchModel({
          sessionID,
          model: { id: modelId, providerID, ...(variant ? { variant } : {}) },
        })
        .catch((err: unknown) =>
          log.warn(
            "[claude-pool] could not switch the session to the fallback model",
            err instanceof Error ? err.message : err,
          ),
        );
    });

    const stopAccountsWatch = watchAccounts(() => {
      void ctx.provider.reload().catch((err: unknown) =>
        log.warn("[claude-pool] provider reload failed", err instanceof Error ? err.message : err),
      );
    });

    return async () => {
      stopAccountsWatch();
      stopWatching();
      await releaseProxy();
    };
  },
};

/**
 * CLI presence check for the model refresh, capped so a slow probe can never
 * block plugin load. Unknown results default to "present".
 */
async function probeCliPresence(): Promise<boolean> {
  if (cliPresentAt && Date.now() - cliPresentAt < CLI_PRESENT_TTL_MS) return true;
  if (cliProbe) return cliProbe;
  const probe = (async () => {
    try {
      const detection = await Promise.race([
        detectClaudeCode(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      const present = detection ? detection.status !== "missing-cli" : true;
      // A missing CLI is not remembered, so a fresh install shows at once.
      if (detection && present) cliPresentAt = Date.now();
      return present;
    } catch {
      return true;
    }
  })();
  cliProbe = probe;
  void probe.finally(() => {
    if (cliProbe === probe) cliProbe = undefined;
  });
  return cliProbe;
}

/**
 * Every location sets the plugin up, all at once after a reload: they share
 * one probe in flight, and a CLI found present stays so for a while.
 */
const CLI_PRESENT_TTL_MS = 5 * 60_000;
let cliProbe: Promise<boolean> | undefined;
let cliPresentAt = 0;

export default ClaudeCodePlugin;

export { detectClaudeCode } from "./detect.js";
export { getClaudeModels } from "./models.js";
export { startProxy, stopProxy, getClaudeProxyBaseUrl } from "./proxy.js";
