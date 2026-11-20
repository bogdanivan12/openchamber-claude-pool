import { z } from "zod";
import { lockFile, poolDataDir, stateFile } from "./paths.ts";
import { readJsonFile, withLock, writeJsonAtomic } from "./store-io.ts";

export const CONVERSATION_TTL_MS = 30 * 24 * 3600 * 1000;
/** A conversation counts as active while its last request is younger than this. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

const windowSchema = z.object({ usedPercent: z.number().min(0).max(100), resetsAt: z.number().nullable(), updatedAt: z.number() });
const accountSchema = z.looseObject({
  windows: z.object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() }),
  limitedUntil: z.number().nullable(),
  needsLogin: z.boolean(),
  /** Anthropic rate-limited usage reads for this account until then; shared by the service and the plugin. */
  usageCooldownUntil: z.number().optional(),
});
const stateSchema = z.looseObject({
  version: z.literal(1),
  accounts: z.record(z.string(), accountSchema),
  conversations: z.record(z.string(), z.looseObject({ accountId: z.string(), at: z.number(), activeAt: z.number().optional() })),
});

export type WindowName = "five_hour" | "seven_day";
export type WindowState = z.infer<typeof windowSchema>;
export type AccountState = z.infer<typeof accountSchema>;
export type PoolState = z.infer<typeof stateSchema>;

export const emptyState = (): PoolState => ({ version: 1, accounts: {}, conversations: {} });

export function readState(dataDir: string = poolDataDir()): PoolState {
  try {
    const raw = readJsonFile(stateFile(dataDir));
    return raw === undefined ? emptyState() : stateSchema.parse(raw);
  } catch {
    return emptyState(); // rebuilt from the next events and usage reads
  }
}

export function updateState(mutate: (s: PoolState) => void, dataDir: string = poolDataDir(), now: number = Date.now()): PoolState {
  return withLock(lockFile(dataDir), () => {
    const s = readState(dataDir);
    mutate(s);
    for (const [key, b] of Object.entries(s.conversations)) {
      if (now - b.at > CONVERSATION_TTL_MS) delete s.conversations[key];
    }
    writeJsonAtomic(stateFile(dataDir), s);
    return s;
  });
}

export function accountState(s: PoolState, id: string): AccountState {
  return (s.accounts[id] ??= { windows: {}, limitedUntil: null, needsLogin: false });
}

export function recordWindow(s: PoolState, id: string, name: WindowName, w: WindowState): void {
  if (!Number.isFinite(w.usedPercent)) return;
  const a = accountState(s, id);
  const prev = a.windows[name];
  if (!prev || w.updatedAt >= prev.updatedAt) a.windows[name] = { ...w, usedPercent: clampPercent(w.usedPercent) };
}

export function markLimited(s: PoolState, id: string, until: number): void {
  const a = accountState(s, id);
  a.limitedUntil = Math.max(a.limitedUntil ?? 0, until);
}

export function setNeedsLogin(s: PoolState, id: string, value: boolean): void {
  accountState(s, id).needsLogin = value;
}

export function bindConversation(s: PoolState, key: string, id: string, now: number): void {
  s.conversations[key] = { accountId: id, at: now, activeAt: now };
}

/** Records that the conversation just made a request. No-op for an unknown conversation. */
export function touchConversation(s: PoolState, key: string, now: number): void {
  const c = s.conversations[key];
  if (c) c.activeAt = now;
}

/** Active conversations per account id (last request within the window). */
export function activeConversations(s: PoolState, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of Object.values(s.conversations)) {
    if (c.activeAt !== undefined && now - c.activeAt <= ACTIVE_WINDOW_MS) out[c.accountId] = (out[c.accountId] ?? 0) + 1;
  }
  return out;
}

export function windowNameFromRateLimitType(t: string | undefined): WindowName | undefined {
  return t === "five_hour" || t === "seven_day" ? t : undefined;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Input is the SDK's 0..1 `utilization`. */
export function fractionToPercent(f: number): number {
  if (!Number.isFinite(f)) return f > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, round1(f * 100)));
}

/** Input is already on the 0..100 scale. */
export function clampPercent(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.min(100, Math.max(0, round1(p)));
}
