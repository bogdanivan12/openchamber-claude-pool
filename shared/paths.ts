import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep, isAbsolute } from "node:path";

export function poolDataDir(home: string = homedir()): string {
  const override = process.env.CLAUDE_POOL_HOME?.trim();
  return override ? resolve(override) : join(home, ".claude-pool");
}

export const accountsFile = (dataDir: string = poolDataDir()): string => join(dataDir, "accounts.json");
export const stateFile = (dataDir: string = poolDataDir()): string => join(dataDir, "state.json");
export const lockFile = (dataDir: string = poolDataDir()): string => join(dataDir, "state.lock");
export const defaultConfigDir = (home: string = homedir()): string => join(home, ".claude");
export const newAccountDir = (id: string, dataDir: string = poolDataDir()): string => join(dataDir, "accounts", id);

/** Absolute, `~` expanded, no trailing separator (except a filesystem root). */
export function normalizeDir(p: string, home: string = homedir()): string {
  let value = p.trim();
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(home, value.slice(2));
  let out = resolve(value);
  const root = parse(out).root;
  while (out.length > root.length && (out.endsWith(sep) || out.endsWith("/"))) out = out.slice(0, -1);
  return out;
}

export const isDefaultConfigDir = (dir: string, home: string = homedir()): boolean =>
  normalizeDir(dir, home) === defaultConfigDir(home);

/** Claude Code keys a non-default config dir's Keychain item by sha256 of the exact dir string. */
export function keychainService(configDir: string, home: string = homedir()): string {
  if (isDefaultConfigDir(configDir, home)) return "Claude Code-credentials";
  const hash = createHash("sha256").update(normalizeDir(configDir, home)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** True only for `<dataDir>/accounts/<one segment>`: dirs the pool created and may delete. */
export function isInsidePoolAccounts(dir: string, dataDir: string = poolDataDir()): boolean {
  const rel = relative(join(dataDir, "accounts"), normalizeDir(dir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}
