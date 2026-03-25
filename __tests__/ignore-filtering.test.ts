import path from "path";
import fs from "fs/promises";
import os from "os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgnoreManager, describeIgnoreSpecInput } from "../ignore-manager.js";
import {
  buildDirectoryTree,
  listDirectoryEntries,
  listDirectoryEntriesWithSizes,
  searchFilesWithValidation,
  setAllowedDirectories,
} from "../lib.js";

describe("ignore-aware filtering", () => {
  let rootDir: string;
  let ignoreManager: IgnoreManager | null;
  let customIgnorePath: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fs-ignore-"));
    rootDir = await fs.realpath(rootDir);
    customIgnorePath = path.join(rootDir, "custom.ignore");

    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(rootDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "bin"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "obj"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "build"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "coverage"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "custom-skip"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "nested", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "index.js"), "console.log('src');");
    await fs.writeFile(path.join(rootDir, "node_modules", "pkg", "index.js"), "module.exports = {};");
    await fs.writeFile(path.join(rootDir, ".git", "config"), "[core]");
    await fs.writeFile(path.join(rootDir, "bin", "tool.exe"), "");
    await fs.writeFile(path.join(rootDir, "obj", "main.o"), "");
    await fs.writeFile(path.join(rootDir, "dist", "bundle.js"), "");
    await fs.writeFile(path.join(rootDir, "build", "output.js"), "");
    await fs.writeFile(path.join(rootDir, "coverage", "lcov.info"), "");
    await fs.writeFile(path.join(rootDir, "custom-skip", "secret.txt"), "");
    await fs.writeFile(path.join(rootDir, "ignored-root.txt"), "");
    await fs.writeFile(path.join(rootDir, "nested", "keep.js"), "");
    await fs.writeFile(path.join(rootDir, "nested", "drop.tmp"), "");
    await fs.writeFile(path.join(rootDir, "nested", "important.tmp"), "");
    await fs.writeFile(path.join(rootDir, "nested", "node_modules", "deep.js"), "");

    await fs.writeFile(path.join(rootDir, ".gitignore"), "node_modules/\n.git/\n");
    await fs.writeFile(path.join(rootDir, ".cursorignore"), "bin/\nobj/\ndist/\nbuild/\ncoverage/\n");
    await fs.writeFile(path.join(rootDir, ".mcpignore"), "ignored-root.txt\n");
    await fs.writeFile(path.join(rootDir, "nested", ".mcpignore"), "*.tmp\n!important.tmp\n");
    await fs.writeFile(customIgnorePath, "custom-skip/\n");

    setAllowedDirectories([rootDir]);
    ignoreManager = await IgnoreManager.create({
      ignoreFiles: [".gitignore", ".cursorignore", customIgnorePath, ".mcpignore"],
      allowedRoots: [rootDir],
      cwd: rootDir,
    });
  });

  afterEach(async () => {
    setAllowedDirectories([]);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("classifies discoverable and explicit ignore inputs", () => {
    expect(describeIgnoreSpecInput(".gitignore", rootDir)).toEqual({
      kind: "discoverable-name",
      value: ".gitignore",
    });

    const explicit = describeIgnoreSpecInput("nested\\custom.ignore", rootDir);
    expect(explicit.kind).toBe("explicit-file");
  });

  it("fails fast for missing explicit ignore files", async () => {
    await expect(
      IgnoreManager.create({
        ignoreFiles: [path.join(rootDir, "missing.ignore")],
        allowedRoots: [rootDir],
        cwd: rootDir,
      }),
    ).rejects.toThrow("Ignore file not found or unreadable");
  });

  it("filters list_directory results using all configured ignore sources", async () => {
    const entries = await listDirectoryEntries(rootDir, { ignoreManager });
    const names = entries.map((entry) => entry.name).sort();

    expect(names).toContain("src");
    expect(names).toContain("nested");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("bin");
    expect(names).not.toContain("obj");
    expect(names).not.toContain("dist");
    expect(names).not.toContain("build");
    expect(names).not.toContain("coverage");
    expect(names).not.toContain("custom-skip");
    expect(names).not.toContain("ignored-root.txt");
  });

  it("filters list_directory_with_sizes results consistently", async () => {
    const entries = await listDirectoryEntriesWithSizes(rootDir, { ignoreManager });
    const names = entries.map((entry) => entry.name).sort();

    expect(names).toContain("src");
    expect(names).toContain("nested");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("bin");
    expect(names).not.toContain("obj");
    expect(names).not.toContain("dist");
    expect(names).not.toContain("build");
  });

  it("filters directory_tree output across root and nested ignore files", async () => {
    const tree = await buildDirectoryTree(rootDir, rootDir, { ignoreManager });
    const rootNames = tree.map((entry) => entry.name).sort();

    expect(rootNames).toContain("src");
    expect(rootNames).toContain("nested");
    expect(rootNames).not.toContain("node_modules");
    expect(rootNames).not.toContain(".git");
    expect(rootNames).not.toContain("dist");
    expect(rootNames).not.toContain("build");

    const nested = tree.find((entry) => entry.name === "nested");
    const nestedNames = nested?.children?.map((entry) => entry.name).sort() ?? [];
    expect(nestedNames).toContain("keep.js");
    expect(nestedNames).toContain("important.tmp");
    expect(nestedNames).not.toContain("drop.tmp");
    expect(nestedNames).not.toContain("node_modules");
  });

  it("filters search_files results consistently", async () => {
    const results = await searchFilesWithValidation(rootDir, "**/*", [rootDir], {
      ignoreManager,
    });
    const relativeResults = results
      .map((result) => path.relative(rootDir, result).split(path.sep).join("/"))
      .sort();

    expect(relativeResults).toContain("src/index.js");
    expect(relativeResults).toContain("nested/keep.js");
    expect(relativeResults).toContain("nested/important.tmp");
    expect(relativeResults).not.toContain("node_modules/pkg/index.js");
    expect(relativeResults).not.toContain(".git/config");
    expect(relativeResults).not.toContain("bin/tool.exe");
    expect(relativeResults).not.toContain("obj/main.o");
    expect(relativeResults).not.toContain("dist/bundle.js");
    expect(relativeResults).not.toContain("build/output.js");
    expect(relativeResults).not.toContain("coverage/lcov.info");
    expect(relativeResults).not.toContain("custom-skip/secret.txt");
    expect(relativeResults).not.toContain("ignored-root.txt");
    expect(relativeResults).not.toContain("nested/drop.tmp");
    expect(relativeResults).not.toContain("nested/node_modules/deep.js");
  });
});
