import { randomBytes } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { accountsFile, defaultConfigDir, lockFile, normalizeDir, poolDataDir, sameDir } from "./paths.ts";
import { readJsonFile, sleepSync, withLock, writeJsonAtomic } from "./store-io.ts";

export const DEFAULT_THRESHOLD = 90;
export const MIN_THRESHOLD = 50;
export const MAX_THRESHOLD = 100;

const accountSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{6}$/),
  label: z.string().trim().min(1).max(40),
  configDir: z.string().min(1),
  order: z.number().int().min(0),
  enabled: z.boolean(),
  email: z.string().optional(),
  plan: z.string().optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountSchema),
  threshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
});

export type Account = z.infer<typeof accountSchema>;
export type AccountsFile = z.infer<typeof fileSchema>;

export const emptyAccounts = (): AccountsFile => ({ version: 1, accounts: [], threshold: DEFAULT_THRESHOLD });

class CorruptError extends Error {}

function parse(raw: unknown): AccountsFile {
  const result = fileSchema.safeParse(raw);
  if (!result.success) throw new CorruptError(result.error.message);
  const file = result.data;
  const ids = new Set(file.accounts.map((a) => a.id));
  if (ids.size !== file.accounts.length) throw new CorruptError("duplicate account id");
  return file;
}

/** Reads and validates. Throws CorruptError (bad JSON or schema) or the raw I/O error. */
function load(path: string): AccountsFile {
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (err) {
    if (err instanceof SyntaxError) throw new CorruptError(err.message);
    throw err;
  }
  return raw === undefined ? emptyAccounts() : parse(raw);
}

function quarantine(path: string): void {
  let target = `${path}.bak`;
  if (existsSync(target)) target = `${path}.bak.${Date.now()}`;
  try {
    renameSync(path, target);
  } catch {}
}

const warnCorrupt = (err: Error): void =>
  console.warn("[claude-pool] accounts.json was unreadable and was moved to a .bak file:", err.message);

/** Non-locking loader for callers that already hold the lock: quarantines corrupt files, rethrows I/O errors. */
function loadLocked(path: string): AccountsFile {
  try {
    return load(path);
  } catch (err) {
    if (!(err instanceof CorruptError)) throw err;
    quarantine(path);
    warnCorrupt(err);
    return emptyAccounts();
  }
}

const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

/**
 * Windows can fail a read for a moment while another process renames the file
 * into place. Retries up to 3 times (15 ms, 30 ms, 45 ms) before rethrowing.
 */
export function readWithRetry<T>(fn: () => T, sleep: (ms: number) => void = sleepSync): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (attempt > 3 || typeof code !== "string" || !TRANSIENT_CODES.has(code)) throw err;
      sleep(15 * attempt);
    }
  }
}

export function readAccounts(dataDir: string = poolDataDir()): AccountsFile {
  const path = accountsFile(dataDir);
  try {
    return readWithRetry(() => load(path));
  } catch (err) {
    if (!(err instanceof CorruptError)) {
      console.warn("[claude-pool] could not read accounts.json:", (err as Error).message);
      return emptyAccounts();
    }
  }
  try {
    // Re-read under the lock: another process may have replaced the file meanwhile.
    return withLock(lockFile(dataDir), () => loadLocked(path));
  } catch (err) {
    console.warn("[claude-pool] could not read accounts.json:", (err as Error).message);
    return emptyAccounts();
  }
}

function checkConfigDirs(file: AccountsFile): void {
  for (const a of file.accounts) {
    const dir = a.configDir.trim();
    if (!dir) throw new Error("configDir must not be empty");
    const homeRelative = dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\");
    if (!homeRelative && !isAbsolute(dir)) throw new Error(`configDir must be absolute: ${a.configDir}`);
  }
}

export function updateAccounts(mutate: (file: AccountsFile) => void, dataDir: string = poolDataDir()): AccountsFile {
  return withLock(lockFile(dataDir), () => {
    const file = loadLocked(accountsFile(dataDir));
    mutate(file);
    checkConfigDirs(file);
    for (const a of file.accounts) a.configDir = normalizeDir(a.configDir);
    if (file.accounts.some((a, i) => file.accounts.some((b, j) => i < j && sameDir(a.configDir, b.configDir)))) {
      throw new Error("duplicate configDir");
    }
    const valid = parse(file);
    writeJsonAtomic(accountsFile(dataDir), valid);
    return valid;
  });
}

export function newAccountId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = randomBytes(3).toString("hex");
    if (!used.has(id)) return id;
  }
}

export const enabledAccounts = (file: AccountsFile): Account[] =>
  file.accounts.filter((a) => a.enabled).sort((a, b) => a.order - b.order);

export function findByConfigDir(file: AccountsFile, dir: string | undefined, platform: NodeJS.Platform = process.platform): Account | undefined {
  const wanted = dir ?? defaultConfigDir();
  return file.accounts.find((a) => sameDir(a.configDir, wanted, undefined, platform));
}
