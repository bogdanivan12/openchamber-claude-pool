import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

/**
 * Cross-process lock via an exclusive-create file. `fn` must finish well within
 * `staleMs` (callers only do small JSON writes): past that, another process may
 * legitimately take the lock over. Each lock file holds a unique token and is
 * released only if it still holds ours, so a late release never deletes a lock
 * that someone else has taken over.
 */
export function withLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): T {
  const staleMs = opts.staleMs ?? 10_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, token);
      } catch (err) {
        try { closeSync(fd); } catch {}
        try { unlinkSync(lockPath); } catch {}
        throw err;
      }
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          // Only one racer can win this rename; the others get ENOENT and loop.
          const aside = `${lockPath}.stale.${randomBytes(6).toString("hex")}`;
          renameSync(lockPath, aside);
          if (Date.now() - statSync(aside).mtimeMs <= staleMs) {
            // We grabbed a live lock created in the gap: put it back if we can.
            try { if (!existsSync(lockPath)) renameSync(aside, lockPath); } catch {}
          }
          try { unlinkSync(aside); } catch {}
          continue;
        }
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished between checks
        // Any other error: do not spin; fall through to the deadline check and sleep.
      }
      if (Date.now() > deadline) throw new Error(`could not take the Claude Pool lock at ${lockPath}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
    } catch {}
  }
}
