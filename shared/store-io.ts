import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const sab = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sab, 0, 0, ms);
}

export function readJsonFile(path: string): unknown | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** temp + rename; retried on Windows sharing errors (EPERM/EBUSY/EACCES). */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        try { unlinkSync(tmp); } catch {}
        throw err;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

export function withLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): T {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // vanished between checks
      }
      if (Date.now() > deadline) throw new Error(`could not take the Claude Pool lock at ${lockPath}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}
