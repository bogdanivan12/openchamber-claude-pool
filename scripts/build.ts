/** Bundles every entry that installation loads. Usage: bun scripts/build.ts [plugin|service|ui|all] */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const target = process.argv[2] ?? "all";
if (!["plugin", "service", "ui", "all"].includes(target)) {
  console.error(`Unknown target "${target}". Usage: bun scripts/build.ts [plugin|service|ui|all]`);
  process.exit(1);
}

async function bundle(entry: string, outfile: string, platform: "node" | "browser") {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target: platform === "node" ? "node" : "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bundle failed: ${entry}`);
  }
  await Bun.write(join(root, outfile), await result.outputs[0].text());
  console.log(`built ${outfile}`);
}

if (target === "plugin" || target === "all") await bundle("plugin/src/index.ts", "plugin/index.js", "node");
if (target === "service" || target === "all") await bundle("service/src/main.ts", "service/main.js", "node");
if (target === "ui" || target === "all") {
  await bundle("ui/panel/main.ts", "ui/panel/main.js", "browser");
  await bundle("ui/status/main.ts", "ui/status/main.js", "browser");
}
