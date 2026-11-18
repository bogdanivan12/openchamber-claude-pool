import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeDir } from "../../shared/paths.ts";

export async function findImportCandidates(deps: {
  home: string;
  existing: string[];
  hasCredential: (dir: string) => Promise<boolean>;
  listHome?: () => string[];
}): Promise<string[]> {
  const list = deps.listHome ?? (() => {
    try {
      return readdirSync(deps.home).filter((n) => {
        try { return statSync(join(deps.home, n)).isDirectory(); } catch { return false; }
      });
    } catch { return []; }
  });
  const names = list().filter((n) => n === ".claude" || (n.startsWith(".claude-") && n !== ".claude-pool"));
  const taken = new Set(deps.existing.map((d) => normalizeDir(d, deps.home)));
  const out: string[] = [];
  for (const n of names.sort((a, b) => (a === ".claude" ? -1 : b === ".claude" ? 1 : a.localeCompare(b)))) {
    const dir = join(deps.home, n);
    if (taken.has(normalizeDir(dir, deps.home))) continue;
    if (await deps.hasCredential(dir)) out.push(dir);
  }
  return out;
}
