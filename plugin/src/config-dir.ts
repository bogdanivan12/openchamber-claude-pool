/** Claude Code config directory helpers. */
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Where Claude Code keeps its sessions and CLAUDE.md for this account. */
export function claudeConfigDir(configDir?: string): string {
  return configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
