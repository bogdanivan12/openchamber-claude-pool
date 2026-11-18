import { expect, test } from "bun:test";
import { staleBundles } from "./bundles-core";

test("identical bundles are fresh", () => {
  const m = new Map([["a.js", "x\n"], ["b.js", "y\n"]]);
  expect(staleBundles(m, new Map(m))).toEqual([]);
});

test("reports only the changed files", () => {
  const before = new Map([["a.js", "x"], ["b.js", "y"]]);
  const after = new Map([["a.js", "x"], ["b.js", "z"]]);
  expect(staleBundles(before, after)).toEqual(["b.js"]);
});

test("CRLF checkout is not stale", () => {
  expect(staleBundles(new Map([["a.js", "x\r\ny\r\n"]]), new Map([["a.js", "x\ny\n"]]))).toEqual([]);
});

test("a file missing before is stale", () => {
  expect(staleBundles(new Map(), new Map([["a.js", "x"]]))).toEqual(["a.js"]);
});
