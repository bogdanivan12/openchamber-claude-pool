import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychainService, normalizeDir } from "./paths.ts";

export type ClaudeCredential = { accessToken: string; expiresAt: number | null; subscriptionType: string | null };
export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, encoding: "utf8", windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

export function parseCredentialBlob(raw: string): ClaudeCredential | null {
  try {
    const oauth = (JSON.parse(raw.trim()) as any)?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

export type CredentialRead = { cred: ClaudeCredential | null; reason?: "not-found" | "error"; message?: string };
type CredentialDeps = { platform?: NodeJS.Platform; home?: string; exec?: ExecFn; readFile?: (path: string) => string };

const errCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/**
 * Read-only. Never logs the token. Keychain first on macOS (the file there is a stale leftover).
 * `reason` is "not-found" only when every source said the login does not exist; any other failure
 * (denied prompt, timeout, unreadable file) is "error" so callers do not mistake it for a signed-out account.
 */
export async function readCredentialDetailed(configDir: string, deps: CredentialDeps = {}): Promise<CredentialRead> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const dir = platform === "win32" ? configDir : normalizeDir(configDir, home);
  let message: string | undefined;

  if (platform === "darwin") {
    try {
      const cred = parseCredentialBlob(await exec("security", ["find-generic-password", "-s", keychainService(dir, home), "-w"]));
      if (cred) return { cred };
    } catch (err) {
      const code = errCode(err);
      if (code !== 44) message = `Keychain access failed (exit ${code ?? "unknown"})`;
    }
  }
  try {
    const cred = parseCredentialBlob(readFile(join(dir, ".credentials.json")));
    if (cred) return { cred };
  } catch (err) {
    const code = errCode(err);
    if (code !== "ENOENT") message ??= `credentials file unreadable (${typeof code === "string" ? code : "I/O error"})`;
  }
  return message === undefined ? { cred: null, reason: "not-found" } : { cred: null, reason: "error", message };
}

export async function readCredential(configDir: string, deps: CredentialDeps = {}): Promise<ClaudeCredential | null> {
  return (await readCredentialDetailed(configDir, deps)).cred;
}
