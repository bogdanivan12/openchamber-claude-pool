import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod";
import { accountsFile, defaultConfigDir, lockFile, normalizeDir, poolDataDir } from "./paths.ts";
import { readJsonFile, withLock, writeJsonAtomic } from "./store-io.ts";

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

function parse(raw: unknown): AccountsFile {
  const file = fileSchema.parse(raw);
  const ids = new Set(file.accounts.map((a) => a.id));
  if (ids.size !== file.accounts.length) throw new Error("duplicate account id");
  return file;
}

export function readAccounts(dataDir: string = poolDataDir()): AccountsFile {
  const path = accountsFile(dataDir);
  try {
    const raw = readJsonFile(path);
    return raw === undefined ? emptyAccounts() : parse(raw);
  } catch (err) {
    try { renameSync(path, `${path}.bak`); } catch {}
    console.warn("[claude-pool] accounts.json was unreadable and was moved to accounts.json.bak:", (err as Error).message);
    return emptyAccounts();
  }
}

export function updateAccounts(mutate: (file: AccountsFile) => void, dataDir: string = poolDataDir()): AccountsFile {
  return withLock(lockFile(dataDir), () => {
    const file = readAccounts(dataDir);
    mutate(file);
    for (const a of file.accounts) a.configDir = normalizeDir(a.configDir);
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

export function findByConfigDir(file: AccountsFile, dir: string | undefined): Account | undefined {
  const wanted = normalizeDir(dir ?? defaultConfigDir());
  return file.accounts.find((a) => normalizeDir(a.configDir) === wanted);
}
