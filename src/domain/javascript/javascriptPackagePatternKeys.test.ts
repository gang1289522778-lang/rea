import { describe, expect, it } from "vitest";

import {
  isSingleStarPatternKey,
  matchPackagePatternKey,
} from "./javascriptPackagePatternKeys.js";

describe("single-star pattern keys", () => {
  it.each([
    ["./*", true],
    ["./internal/*", true],
    ["./internal/*.js", true],
    [".", false],
    ["./exact", false],
    ["./*/", true],
    ["./a**", false],
    ["**", false],
  ])("classifies %j as a single-star pattern: %s", (key, expected) => {
    expect(isSingleStarPatternKey(key)).toBe(expected);
  });
});

describe("package pattern key matching", () => {
  it("captures the substring between prefix and suffix", () => {
    expect(
      matchPackagePatternKey(["./internal/*.mjs"], "./internal/db.mjs"),
    ).toEqual({ key: "./internal/*.mjs", capture: "db" });
  });

  it("requires the capture to consume at least one character", () => {
    expect(matchPackagePatternKey(["./feature*"], "./feature")).toBeNull();
  });

  it("prefers the pattern key with the longest prefix", () => {
    expect(
      matchPackagePatternKey(["./*", "./internal/*"], "./internal/db"),
    ).toEqual({ key: "./internal/*", capture: "db" });
  });

  it("breaks prefix ties with the longer suffix", () => {
    expect(matchPackagePatternKey(["./a*", "./a*c"], "./abc")).toEqual({
      key: "./a*c",
      capture: "b",
    });
  });

  it.each([
    ["a request no key encloses", "./other/db", ["./internal/*.js"]],
    ["a map without pattern keys", "./internal/db", ["./internal/exact"]],
  ])("refuses %s", (_name, request, keys) => {
    expect(matchPackagePatternKey(keys, request)).toBeNull();
  });

  it.each([
    ["./internal/x*", "x*"],
    ["./internal/x/", "x/"],
  ])("captures literal request text in %j", (request, capture) => {
    expect(matchPackagePatternKey(["./internal/*"], request)).toEqual({
      key: "./internal/*",
      capture,
    });
  });
});
