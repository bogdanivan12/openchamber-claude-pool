import { buildClaudeCodeChildEnv } from "../../plugin/src/auth-env.ts";
import { interpretClaudeAuthStatus } from "../../plugin/src/detect.ts";
import { resolveClaudeCli, runCliProbe } from "../../plugin/src/executable-path.ts";
import { isDefaultConfigDir } from "../../shared/paths.ts";

export type AuthInfo = { loggedIn: boolean; email: string | null; plan: string | null };

const SIGNED_OUT: AuthInfo = { loggedIn: false, email: null, plan: null };

/** Child env for a `claude` run against one config dir (API-key variables stripped). */
export function envForDir(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...buildClaudeCodeChildEnv(process.env) };
  if (isDefaultConfigDir(configDir)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

async function defaultRun(configDir: string): Promise<string | null> {
  const env = envForDir(configDir);
  const bin = await resolveClaudeCli(env);
  if (!bin) return null;
  const result = await runCliProbe(bin, ["auth", "status", "--json"], { env, timeoutMs: 8000 });
  return result.stdout.trim() || null;
}

export async function readAuthStatus(configDir: string, deps: { run?: (dir: string) => Promise<string | null> } = {}): Promise<AuthInfo> {
  let out: string | null;
  try {
    out = await (deps.run ?? defaultRun)(configDir);
  } catch {
    return { ...SIGNED_OUT };
  }
  if (!out) return { ...SIGNED_OUT };
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    return {
      loggedIn: interpretClaudeAuthStatus(j).loggedIn,
      email: typeof j.email === "string" ? j.email : null,
      plan: typeof j.subscriptionType === "string" ? j.subscriptionType : null,
    };
  } catch {
    return { ...SIGNED_OUT };
  }
}

/** Best effort: removes the Keychain item a pool-created dir leaves behind. Never throws. */
export async function logoutDir(dir: string): Promise<void> {
  try {
    const env = envForDir(dir);
    const bin = await resolveClaudeCli(env);
    if (!bin) return;
    await runCliProbe(bin, ["auth", "logout"], { env, timeoutMs: 8000 });
  } catch {}
}
