import { describe, expect, it } from "vitest";
import { parseCommandLineArgs } from "../cli.js";

describe("parseCommandLineArgs", () => {
  it("parses repeated ignore-file flags and positional directories", () => {
    const parsed = parseCommandLineArgs([
      "--ignore-file",
      ".gitignore",
      "--ignore-file=.cursorignore",
      "/workspace/a",
      "/workspace/b",
    ]);

    expect(parsed.ignoreFiles).toEqual([".gitignore", ".cursorignore"]);
    expect(parsed.allowedDirectories).toEqual(["/workspace/a", "/workspace/b"]);
    expect(parsed.respectGitignore).toBe(false);
  });

  it("supports respect-gitignore and the -- terminator", () => {
    const parsed = parseCommandLineArgs([
      "--respect-gitignore",
      "--",
      "--not-a-flag",
      "/workspace/a",
    ]);

    expect(parsed.respectGitignore).toBe(true);
    expect(parsed.allowedDirectories).toEqual(["--not-a-flag", "/workspace/a"]);
  });
});
