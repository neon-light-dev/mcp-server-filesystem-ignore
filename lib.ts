import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { createTwoFilesPatch } from "diff";
import { minimatch } from "minimatch";
import type { Dirent } from "fs";
import type { IgnoreManager } from "./ignore-manager.js";
import { normalizePath, expandHome } from "./path-utils.js";
import { isPathWithinAllowedDirectories } from "./path-validation.js";

let allowedDirectories: string[] = [];

export function setAllowedDirectories(directories: string[]): void {
  allowedDirectories = [...directories];
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface FileEdit {
  oldText: string;
  newText: string;
}

export interface SearchOptions {
  excludePatterns?: string[];
  ignoreManager?: IgnoreManager | null;
}

export interface ListDirectoryOptions {
  ignoreManager?: IgnoreManager | null;
}

export interface DirectoryTreeOptions {
  excludePatterns?: string[];
  ignoreManager?: IgnoreManager | null;
}

export interface TreeEntry {
  name: string;
  type: "file" | "directory";
  children?: TreeEntry[];
}

export interface DirectoryEntryWithSize {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: Date;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0 B";

  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i < 0 || i === 0) return `${bytes} ${units[0]}`;

  const unitIndex = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function createUnifiedDiff(
  originalContent: string,
  newContent: string,
  filepath = "file",
): string {
  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizeLineEndings(originalContent),
    normalizeLineEndings(newContent),
    "original",
    "modified",
  );
}

function resolveRelativePathAgainstAllowedDirectories(relativePath: string): string {
  if (allowedDirectories.length === 0) {
    return path.resolve(process.cwd(), relativePath);
  }

  for (const allowedDir of allowedDirectories) {
    const candidate = path.resolve(allowedDir, relativePath);
    if (isPathWithinAllowedDirectories(normalizePath(candidate), allowedDirectories)) {
      return candidate;
    }
  }

  return path.resolve(allowedDirectories[0], relativePath);
}

export async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : resolveRelativePathAgainstAllowedDirectories(expandedPath);

  const normalizedRequested = normalizePath(absolute);
  const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, allowedDirectories);
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(", ")}`,
    );
  }

  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    if (!isPathWithinAllowedDirectories(normalizedReal, allowedDirectories)) {
      throw new Error(
        `Access denied - symlink target outside allowed directories: ${realPath} not in ${allowedDirectories.join(", ")}`,
      );
    }
    return realPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const parentDir = path.dirname(absolute);
      try {
        const realParentPath = await fs.realpath(parentDir);
        const normalizedParent = normalizePath(realParentPath);
        if (!isPathWithinAllowedDirectories(normalizedParent, allowedDirectories)) {
          throw new Error(
            `Access denied - parent directory outside allowed directories: ${realParentPath} not in ${allowedDirectories.join(", ")}`,
          );
        }
        return absolute;
      } catch {
        throw new Error(`Parent directory does not exist: ${parentDir}`);
      }
    }

    throw error;
  }
}

export async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

export async function readFileContent(
  filePath: string,
  encoding = "utf-8",
): Promise<string> {
  return fs.readFile(filePath, encoding as BufferEncoding);
}

export async function writeFileContent(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const tempPath = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, content, "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (renameError) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw renameError;
    }
  }
}

export async function applyFileEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun = false,
): Promise<string> {
  const content = normalizeLineEndings(await fs.readFile(filePath, "utf-8"));
  let modifiedContent = content;

  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    const oldLines = normalizedOld.split("\n");
    const contentLines = modifiedContent.split("\n");
    let matchFound = false;

    for (let index = 0; index <= contentLines.length - oldLines.length; index++) {
      const potentialMatch = contentLines.slice(index, index + oldLines.length);
      const isMatch = oldLines.every((oldLine, offset) => {
        return oldLine.trim() === potentialMatch[offset]?.trim();
      });

      if (!isMatch) continue;

      const originalIndent = contentLines[index].match(/^\s*/)?.[0] ?? "";
      const newLines = normalizedNew.split("\n").map((line, offset) => {
        if (offset === 0) return originalIndent + line.trimStart();

        const oldIndent = oldLines[offset]?.match(/^\s*/)?.[0] ?? "";
        const newIndent = line.match(/^\s*/)?.[0] ?? "";
        if (oldIndent && newIndent) {
          const relativeIndent = newIndent.length - oldIndent.length;
          return originalIndent + " ".repeat(Math.max(0, relativeIndent)) + line.trimStart();
        }

        return line;
      });

      contentLines.splice(index, oldLines.length, ...newLines);
      modifiedContent = contentLines.join("\n");
      matchFound = true;
      break;
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  const diff = createUnifiedDiff(content, modifiedContent, filePath);
  let numBackticks = 3;
  while (diff.includes("`".repeat(numBackticks))) {
    numBackticks++;
  }

  const fence = "`".repeat(numBackticks);
  const formattedDiff = `${fence}diff\n${diff}${fence}\n\n`;

  if (!dryRun) {
    const tempPath = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, modifiedContent, "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  return formattedDiff;
}

export async function tailFile(filePath: string, numLines: number): Promise<string> {
  const chunkSize = 1024;
  const stats = await fs.stat(filePath);
  if (stats.size === 0) return "";

  const fileHandle = await fs.open(filePath, "r");
  try {
    const lines: string[] = [];
    let position = stats.size;
    const chunk = Buffer.alloc(chunkSize);
    let linesFound = 0;
    let remainingText = "";

    while (position > 0 && linesFound < numLines) {
      const size = Math.min(chunkSize, position);
      position -= size;

      const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
      if (!bytesRead) break;

      const chunkText = chunk.slice(0, bytesRead).toString("utf-8") + remainingText;
      const chunkLines = normalizeLineEndings(chunkText).split("\n");

      if (position > 0) {
        remainingText = chunkLines[0];
        chunkLines.shift();
      }

      for (let index = chunkLines.length - 1; index >= 0 && linesFound < numLines; index--) {
        lines.unshift(chunkLines[index]);
        linesFound++;
      }
    }

    return lines.join("\n");
  } finally {
    await fileHandle.close();
  }
}

export async function headFile(filePath: string, numLines: number): Promise<string> {
  const fileHandle = await fs.open(filePath, "r");
  try {
    const lines: string[] = [];
    const chunk = Buffer.alloc(1024);
    let buffer = "";
    let bytesRead = 0;

    while (lines.length < numLines) {
      const result = await fileHandle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      buffer += chunk.slice(0, result.bytesRead).toString("utf-8");

      const newLineIndex = buffer.lastIndexOf("\n");
      if (newLineIndex === -1) continue;

      const completeLines = buffer.slice(0, newLineIndex).split("\n");
      buffer = buffer.slice(newLineIndex + 1);
      for (const line of completeLines) {
        lines.push(line);
        if (lines.length >= numLines) break;
      }
    }

    if (buffer.length > 0 && lines.length < numLines) {
      lines.push(buffer);
    }

    return lines.join("\n");
  } finally {
    await fileHandle.close();
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function shouldExcludeTreePath(relativePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some((pattern) => {
    if (pattern.includes("*")) {
      return minimatch(relativePath, pattern, { dot: true });
    }

    return (
      minimatch(relativePath, pattern, { dot: true }) ||
      minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
      minimatch(relativePath, `**/${pattern}/**`, { dot: true })
    );
  });
}

function shouldExcludeSearchPath(relativePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some((excludePattern) => {
    return minimatch(relativePath, excludePattern, { dot: true });
  });
}

async function getFilteredDirectoryEntries(
  directoryPath: string,
  ignoreManager?: IgnoreManager | null,
): Promise<Dirent[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  if (!ignoreManager) return entries;
  return ignoreManager.filterDirectoryEntries(directoryPath, entries);
}

export async function listDirectoryEntries(
  directoryPath: string,
  options: ListDirectoryOptions = {},
): Promise<Dirent[]> {
  return getFilteredDirectoryEntries(directoryPath, options.ignoreManager);
}

export async function listDirectoryEntriesWithSizes(
  directoryPath: string,
  options: ListDirectoryOptions = {},
): Promise<DirectoryEntryWithSize[]> {
  const entries = await getFilteredDirectoryEntries(directoryPath, options.ignoreManager);
  return Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      try {
        const stats = await fs.stat(entryPath);
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: stats.size,
          mtime: stats.mtime,
        };
      } catch {
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: 0,
          mtime: new Date(0),
        };
      }
    }),
  );
}

export async function buildDirectoryTree(
  rootPath: string,
  currentPath: string,
  options: DirectoryTreeOptions = {},
): Promise<TreeEntry[]> {
  const validPath = await validatePath(currentPath);
  const entries = await getFilteredDirectoryEntries(validPath, options.ignoreManager);
  const result: TreeEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(validPath, entry.name);
    const relativePath = normalizeRelativePath(path.relative(rootPath, fullPath));
    if (shouldExcludeTreePath(relativePath, options.excludePatterns ?? [])) {
      continue;
    }

    const entryData: TreeEntry = {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };

    if (entry.isDirectory()) {
      entryData.children = await buildDirectoryTree(rootPath, fullPath, options);
    }

    result.push(entryData);
  }

  return result;
}

export async function searchFilesWithValidation(
  rootPath: string,
  pattern: string,
  _allowedDirectories: string[] = allowedDirectories,
  options: SearchOptions = {},
): Promise<string[]> {
  const results: string[] = [];
  const excludePatterns = options.excludePatterns ?? [];

  async function search(currentPath: string): Promise<void> {
    const entries = await getFilteredDirectoryEntries(currentPath, options.ignoreManager);

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        await validatePath(fullPath);
        const relativePath = normalizeRelativePath(path.relative(rootPath, fullPath));
        if (shouldExcludeSearchPath(relativePath, excludePatterns)) {
          continue;
        }

        if (minimatch(relativePath, pattern, { dot: true })) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch {
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}
