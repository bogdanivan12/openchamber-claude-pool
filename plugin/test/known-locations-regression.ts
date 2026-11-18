/**
 * The desktop app starts the server with a minimal PATH, so `claude` is found
 * only through the static install locations. Pins their list and order
 * (official installer first) without touching the real disk.
 *
 * Run: bun test/known-locations-regression.ts
 */
import { join } from "node:path";
import { assert } from "./helpers.ts";

const { knownClaudeLocations } = await import("../src/executable-path.ts");

const home = join("/fake", "home");
const tree: Record<string, string[]> = {
  [join(home, ".nvm", "versions", "node")]: ["v18.0.0", "v22.1.0", "v20.5.0"],
  [join(home, ".local", "share", "fnm", "node-versions")]: ["v20.0.0", "v22.0.0"],
};
const readdir = async (dir: string): Promise<string[]> => {
  if (!tree[dir]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return tree[dir];
};
const npmPrefix = async () => "/npm/prefix";

const list = await knownClaudeLocations({ HOME: home }, { platform: "darwin", readdir, npmPrefix });
const expected = [
  join(home, ".local", "bin", "claude"),
  join("/npm/prefix", "bin", "claude"),
  join("/opt/homebrew", "bin", "claude"),
  join("/usr/local", "bin", "claude"),
  join(home, ".claude", "local", "claude"),
  join(home, ".bun", "bin", "claude"),
  join(home, ".npm-global", "bin", "claude"),
  join(home, ".volta", "bin", "claude"),
  join(home, ".nvm", "versions", "node", "v22.1.0", "bin", "claude"),
  join(home, ".nvm", "versions", "node", "v20.5.0", "bin", "claude"),
  join(home, ".nvm", "versions", "node", "v18.0.0", "bin", "claude"),
  join(home, ".local", "share", "fnm", "node-versions", "v22.0.0", "installation", "bin", "claude"),
  join(home, ".local", "share", "fnm", "node-versions", "v20.0.0", "installation", "bin", "claude"),
];
assert(JSON.stringify(list) === JSON.stringify(expected), `candidate list/order differs:\n${list.join("\n")}`);

// No nvm/fnm trees and a failing npm: only the static candidates remain.
const bare = await knownClaudeLocations({ HOME: home }, {
  platform: "linux",
  readdir: async () => { throw new Error("nope"); },
  npmPrefix: async () => "",
});
assert(bare.length === 7 && bare[0] === expected[0], `bare list wrong: ${bare.join(", ")}`);
assert(!bare.some((p) => p.includes(".nvm")), "no nvm candidate without an nvm tree");

// Windows keeps its own, unchanged candidates.
const win = await knownClaudeLocations({ HOME: home, APPDATA: join(home, "AppData", "Roaming") }, { platform: "win32", readdir, npmPrefix });
assert(win.length === 3 && win.every((p) => !p.includes("homebrew") && !p.includes(".nvm")), `windows list changed: ${win.join(", ")}`);

console.log("known-locations-regression: ok");
