/**
 * Regression: a transcript (and its sidecar folder) is copied to the new
 * account's projects folder under the same relative path, never over a newer file.
 * Run: bun plugin/test/pool-migrate-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pool-mig-xdg-"));
const { migrateTranscript } = await import("../src/migrate.ts");
const from = mkdtempSync(join(tmpdir(), "pool-from-"));
const to = mkdtempSync(join(tmpdir(), "pool-to-"));
const SID = "11111111-2222-3333-4444-555555555555";

mkdirSync(join(from, "projects", "-src-app"), { recursive: true });
writeFileSync(join(from, "projects", "-src-app", `${SID}.jsonl`), '{"uuid":"a"}\n');
mkdirSync(join(from, "projects", "-src-app", SID, "subagents"), { recursive: true });
writeFileSync(join(from, "projects", "-src-app", SID, "subagents", "x.jsonl"), "{}\n");

assert.equal(migrateTranscript(SID, from, to), true);
assert.equal(readFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), "utf8"), '{"uuid":"a"}\n');
assert.ok(existsSync(join(to, "projects", "-src-app", SID, "subagents", "x.jsonl")));
assert.deepEqual(readdirSync(join(to, "projects", "-src-app")).filter((n) => n.endsWith(".tmp")), [], "no temp file left");

// newer destination is kept
writeFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), '{"uuid":"newer"}\n');
const future = new Date(Date.now() + 60_000);
utimesSync(join(to, "projects", "-src-app", `${SID}.jsonl`), future, future);
assert.equal(migrateTranscript(SID, from, to), true);
assert.equal(readFileSync(join(to, "projects", "-src-app", `${SID}.jsonl`), "utf8"), '{"uuid":"newer"}\n');

assert.equal(migrateTranscript("missing-session", from, to), false);

// same account on both sides: nothing to move
assert.equal(migrateTranscript(SID, from, from), false);
assert.equal(migrateTranscript(SID, from, `${from}/`), false);

// a failing rename (destination is a non-empty directory) leaves no temp file behind
const SID2 = "99999999-2222-3333-4444-555555555555";
writeFileSync(join(from, "projects", "-src-app", `${SID2}.jsonl`), '{"uuid":"b"}\n');
const blocker = join(to, "projects", "-src-app", `${SID2}.jsonl`);
mkdirSync(join(blocker, "inner"), { recursive: true });
const past = new Date(Date.now() - 3_600_000);
utimesSync(blocker, past, past);
assert.equal(migrateTranscript(SID2, from, to), false);
assert.deepEqual(readdirSync(join(to, "projects", "-src-app")).filter((n) => n.endsWith(".tmp")), [], "failed copy cleans its temp file");

console.log("ok — pool migrate regression passed");
process.exit(0);
