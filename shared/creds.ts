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

/** Read-only. Never logs the token. Keychain first on macOS (the file there is a stale leftover). */
export async function readCredential(
  configDir: string,
  deps: { platform?: NodeJS.Platform; home?: string; exec?: ExecFn; readFile?: (path: string) => string } = {},
): Promise<ClaudeCredential | null> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const dir = platform === "win32" ? configDir : normalizeDir(configDir, home);

  if (platform === "darwin") {
    try {
      const cred = parseCredentialBlob(await exec("security", ["find-generic-password", "-s", keychainService(dir, home), "-w"]));
      if (cred) return cred;
    } catch {
      // no item, or access denied: try the file
    }
  }
  try {
    return parseCredentialBlob(readFile(join(dir, ".credentials.json")));
  } catch {
    return null;
  }
}
