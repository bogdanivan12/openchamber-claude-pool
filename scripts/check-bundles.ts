/** Fails when a committed bundle differs from a fresh build. Rebuilt files are left in place so `git diff` shows the change. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { staleBundles } from "./bundles-core";

const root = join(import.meta.dir, "..");
const files = ["plugin/index.js", "service/main.js", "ui/panel/main.js", "ui/status/main.js"];
const read = () => new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

const before = read();
const proc = Bun.spawnSync([process.execPath, join(root, "scripts/build.ts"), "all"], { stdout: "inherit", stderr: "inherit" });
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
const stale = staleBundles(before, read());
if (stale.length) {
  console.error(`Stale bundles (run bun run build and commit): ${stale.join(", ")}`);
  process.exit(1);
}
console.log("bundles are fresh");
