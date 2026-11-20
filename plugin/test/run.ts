/**
 * Runs the offline suite: smoke.ts plus every *-regression.ts, each in its
 * own process (they set process-wide env and proxy state). Live tests
 * (haiku-live.ts) are excluded — they need a signed-in Claude CLI.
 *
 * Run: bun test/run.ts [--only <comma-separated file name prefixes>]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const all = [
  "smoke.ts",
  ...readdirSync(dir)
    .filter((name) => name.endsWith("-regression.ts"))
    .sort(),
];

const onlyIndex = process.argv.indexOf("--only");
let files = all;
if (onlyIndex !== -1) {
  const prefixes = (process.argv[onlyIndex + 1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  files = all.filter((name) => prefixes.some((p) => name.startsWith(p)));
  if (prefixes.length === 0 || files.length === 0) {
    console.error(`--only ${prefixes.join(",") || "(empty)"} matches no test file. Available: ${all.join(", ")}`);
    process.exit(1);
  }
}

let failed = 0;
for (const file of files) {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, join(dir, file)], {
    stdout: "pipe",
    stderr: "pipe",
    // Suites run as plain OpenCode, whatever terminal started them;
    // host-regression covers OpenChamber. Usage refresh before routing is
    // off so no suite reads real logins; pool-usage-refresh turns it on itself.
    env: { ...process.env, OPENCHAMBER_RUNTIME: "", CLAUDE_POOL_USAGE_REFRESH: "off" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (code === 0) {
    console.log(`pass ${file} (${seconds}s)`);
    continue;
  }
  failed++;
  console.log(`FAIL ${file} (exit ${code}, ${seconds}s)`);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed > 0 ? 1 : 0);
