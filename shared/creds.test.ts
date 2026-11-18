import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseCredentialBlob, readCredential } from "./creds.ts";

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
});
