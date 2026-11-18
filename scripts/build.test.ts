import { expect, test } from "bun:test";
import { join } from "node:path";

test("an unknown build target exits non-zero with usage", () => {
  const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "build.ts"), "nope"], { stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain("Usage");
});
