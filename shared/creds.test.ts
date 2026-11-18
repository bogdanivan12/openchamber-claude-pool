import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseCredentialBlob, readCredential, readCredentialDetailed } from "./creds.ts";

const blob = JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: 123, subscriptionType: "pro" }, mcpOAuth: {} });

describe("creds", () => {
  it("parses only claudeAiOauth", () => {
    expect(parseCredentialBlob(blob)).toEqual({ accessToken: "tok", expiresAt: 123, subscriptionType: "pro" });
    expect(parseCredentialBlob("{}")).toBeNull();
    expect(parseCredentialBlob("not json")).toBeNull();
  });

  it("macOS reads the keychain item for the dir", async () => {
    const calls: string[][] = [];
    const cred = await readCredential("/Users/u/.claude-b", {
      platform: "darwin", home: "/Users/u",
      exec: async (file, args) => { calls.push([file, ...args]); return blob + "\n"; },
      readFile: () => { throw new Error("should not read file"); },
    });
    expect(cred?.accessToken).toBe("tok");
    expect(calls[0].slice(0, 3)).toEqual(["security", "find-generic-password", "-s"]);
    expect(calls[0][3]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(calls[0][4]).toBe("-w");
  });

  it("macOS falls back to the credentials file when the keychain has nothing", async () => {
    const cred = await readCredential("/Users/u/.claude", {
      platform: "darwin", home: "/Users/u",
      exec: async () => { throw new Error("exit 44"); },
      readFile: (p) => { expect(p).toBe(join("/Users/u/.claude", ".credentials.json")); return blob; },
    });
    expect(cred?.subscriptionType).toBe("pro");
  });

  it("Windows reads <dir>/.credentials.json and never runs security", async () => {
    const cred = await readCredential("C:\\Users\\u\\.claude-pool\\accounts\\abcdef", {
      platform: "win32", home: "C:\\Users\\u",
      exec: async () => { throw new Error("should not exec"); },
      readFile: (p) => { expect(p.endsWith(".credentials.json")).toBe(true); return blob; },
    });
    expect(cred?.accessToken).toBe("tok");
  });

  it("nothing anywhere is null", async () => {
    const cred = await readCredential("/x", {
      platform: "linux", home: "/home/u",
      exec: async () => "", readFile: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    });
    expect(cred).toBeNull();
  });

  const enoent = () => Object.assign(new Error("nope"), { code: "ENOENT" });
  const detailed = (exec: (f: string, a: string[]) => Promise<string>, readFile: (p: string) => string) =>
    readCredentialDetailed("/Users/u/.claude-b", { platform: "darwin", home: "/Users/u", exec, readFile });

  it("keychain exit 44 and no file is not-found", async () => {
    const r = await detailed(async () => { throw Object.assign(new Error("x"), { code: 44 }); }, () => { throw enoent(); });
    expect(r).toEqual({ cred: null, reason: "not-found" });
  });

  it("keychain exit 51, timeout or a missing binary is an error even when the file is absent", async () => {
    for (const code of [51, "ETIMEDOUT", "ENOENT"]) {
      const r = await detailed(async () => { throw Object.assign(new Error("secret stdout"), { code, stdout: "TOKEN" }); }, () => { throw enoent(); });
      expect(r.cred).toBeNull();
      expect(r.reason).toBe("error");
      expect(r.message).toBe(`Keychain access failed (exit ${code})`);
      expect(JSON.stringify(r)).not.toContain("TOKEN");
    }
  });

  it("an unreadable credentials file is an error", async () => {
    const r = await detailed(async () => { throw Object.assign(new Error("x"), { code: 44 }); }, () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(r.cred).toBeNull();
    expect(r.reason).toBe("error");
    expect(r.message).toContain("EACCES");
  });

  it("a keychain error still falls back to a readable file", async () => {
    const r = await detailed(async () => { throw Object.assign(new Error("x"), { code: 51 }); }, () => blob);
    expect(r.cred?.accessToken).toBe("tok");
  });

  it("readCredential stays a thin wrapper", async () => {
    expect(await readCredential("/x", { platform: "linux", home: "/h", readFile: () => { throw enoent(); } })).toBeNull();
  });
});
