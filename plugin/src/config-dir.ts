/** Claude Code config directory helpers. */
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

let poolMode = false;

/**
 * Pool mode (set by the plugin's setup): the default account is always
 * `~/.claude`. The server's own CLAUDE_CONFIG_DIR is ignored, otherwise the
 * default account would silently run on another directory than the one its
 * Keychain item and state belong to.
 */
export function setPoolMode(on: boolean): void {
  poolMode = on;
}
export const isPoolMode = (): boolean => poolMode;

/** Where Claude Code keeps its sessions and CLAUDE.md for this account. */
export function claudeConfigDir(configDir?: string): string {
  if (configDir) return configDir;
  if (poolMode) return join(homedir(), ".claude");
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
