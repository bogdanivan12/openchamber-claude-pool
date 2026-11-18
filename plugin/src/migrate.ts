import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findClaudeSessionFile, getForeignSessionId } from "./session-store.js";
import { setMigrationHook } from "./pool-proxy.js";
import { log } from "./log.js";

/**
 * Copy a Claude transcript (and its sidecar folder) from one account's config
 * dir to another's, under the same relative path. Never overwrites a newer
 * destination. Never throws: a failure returns false and leaves no half file.
 */
export function migrateTranscript(sessionId: string, fromDir: string, toDir: string): boolean {
  try {
    if (resolve(fromDir) === resolve(toDir)) return false;
    const src = findClaudeSessionFile(sessionId, fromDir);
    if (!src) return false;
    const rel = relative(join(fromDir, "projects"), src);
    if (rel.startsWith("..")) return false;
    const dest = join(toDir, "projects", rel);
    if (!(existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs)) {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      try {
        cpSync(src, tmp, { preserveTimestamps: true });
        renameSync(tmp, dest);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    }
    const sidecar = join(dirname(src), sessionId);
    if (existsSync(sidecar)) {
      cpSync(sidecar, join(dirname(dest), sessionId), { recursive: true, force: false, errorOnExist: false });
    }
    return true;
  } catch (error) {
    log.warn("[claude-pool] could not move the Claude session", { error: String(error) });
    return false;
  }
}

export function installTranscriptMigration(): void {
  setMigrationHook((sessionKey, fromDir, toDir) => {
    const sid = getForeignSessionId(sessionKey);
    if (!sid) return;
    const moved = migrateTranscript(sid, fromDir, toDir);
    log.info("[claude-pool] moved the Claude session to the new account", { sessionKey, moved });
  });
}
