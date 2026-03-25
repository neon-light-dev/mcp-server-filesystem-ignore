import fs from "fs/promises";
import path from "path";
import type { Dirent } from "fs";
import ignore, { type Ignore } from "ignore";
import { normalizePath } from "./path-utils.js";
import { isPathWithinAllowedDirectories } from "./path-validation.js";

interface IgnoreTestResult {
  ignored: boolean;
  unignored: boolean;
}

export interface IgnoreManagerInit {
  ignoreFiles: string[];
  respectGitignore?: boolean;
  cwd?: string;
  allowedRoots?: string[];
}

interface DiscoverableIgnoreSpec {
  kind: "discoverable-name";
  value: string;
  order: number;
}

interface ExplicitIgnoreSpec {
  kind: "explicit-file";
  value: string;
  order: number;
  filePath: string;
  baseDirectory: string;
}

type IgnoreSpec = DiscoverableIgnoreSpec | ExplicitIgnoreSpec;

interface MatcherContext {
  baseDirectory: string;
  order: number;
  matcher: Ignore;
}

export interface ParsedIgnoreSpecInput {
  kind: IgnoreSpec["kind"];
  value: string;
  filePath?: string;
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function isWithinOrSame(candidatePath: string, baseDirectory: string): boolean {
  if (candidatePath === baseDirectory) return true;
  return isPathWithinAllowedDirectories(candidatePath, [baseDirectory]);
}

function normalizeIgnoreRelativePath(baseDirectory: string, candidatePath: string, isDirectory: boolean) {
  const relativePath = path.relative(baseDirectory, candidatePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return null;
  }

  const normalized = relativePath.split(path.sep).join("/");
  return isDirectory ? `${normalized}/` : normalized;
}

function getAncestorDirectories(rootDirectory: string, parentDirectory: string): string[] {
  const ancestors: string[] = [];
  let current = normalizePath(path.resolve(parentDirectory));
  const normalizedRoot = normalizePath(path.resolve(rootDirectory));

  while (true) {
    if (!isWithinOrSame(current, normalizedRoot)) {
      break;
    }

    ancestors.push(current);
    if (current === normalizedRoot) {
      break;
    }

    current = normalizePath(path.dirname(current));
  }

  return ancestors.reverse();
}

export function parseIgnoreSpecInput(
  value: string,
  order: number,
  cwd = process.cwd(),
): IgnoreSpec {
  if (!isPathLike(value)) {
    return {
      kind: "discoverable-name",
      value,
      order,
    };
  }

  const resolvedFilePath = path.resolve(cwd, value);
  return {
    kind: "explicit-file",
    value,
    order,
    filePath: normalizePath(resolvedFilePath),
    baseDirectory: normalizePath(path.dirname(resolvedFilePath)),
  };
}

export function describeIgnoreSpecInput(value: string, cwd = process.cwd()): ParsedIgnoreSpecInput {
  const parsed = parseIgnoreSpecInput(value, 0, cwd);
  if (parsed.kind === "explicit-file") {
    return {
      kind: parsed.kind,
      value: parsed.value,
      filePath: parsed.filePath,
    };
  }

  return {
    kind: parsed.kind,
    value: parsed.value,
  };
}

export class IgnoreManager {
  private readonly discoverableSpecs: DiscoverableIgnoreSpec[];
  private readonly explicitSpecs: ExplicitIgnoreSpec[];
  private readonly cwd: string;
  private allowedRoots: string[];
  private readonly matcherCache = new Map<string, Ignore | null>();

  private constructor(specs: IgnoreSpec[], cwd: string, allowedRoots: string[] = []) {
    this.cwd = cwd;
    this.discoverableSpecs = specs
      .filter((spec): spec is DiscoverableIgnoreSpec => spec.kind === "discoverable-name")
      .sort((left, right) => left.order - right.order);
    this.explicitSpecs = specs
      .filter((spec): spec is ExplicitIgnoreSpec => spec.kind === "explicit-file")
      .sort((left, right) => left.order - right.order);
    this.allowedRoots = dedupePreserveOrder(allowedRoots.map((root) => normalizePath(path.resolve(root))));
  }

  static async create(init: IgnoreManagerInit): Promise<IgnoreManager | null> {
    const cwd = init.cwd ?? process.cwd();
    const rawSpecs = dedupePreserveOrder([
      ...init.ignoreFiles,
      ...(init.respectGitignore ? [".gitignore"] : []),
    ]);
    if (rawSpecs.length === 0) {
      return null;
    }

    const specs = rawSpecs.map((value, order) => parseIgnoreSpecInput(value, order, cwd));
    const manager = new IgnoreManager(specs, cwd, init.allowedRoots ?? []);
    await manager.loadExplicitMatchers();
    return manager;
  }

  setAllowedRoots(allowedRoots: string[]): void {
    this.allowedRoots = dedupePreserveOrder(allowedRoots.map((root) => normalizePath(path.resolve(root))));
  }

  isEnabled(): boolean {
    return this.discoverableSpecs.length > 0 || this.explicitSpecs.length > 0;
  }

  getSpecValues(): string[] {
    return [
      ...this.discoverableSpecs.map((spec) => spec.value),
      ...this.explicitSpecs.map((spec) => spec.filePath),
    ];
  }

  async filterDirectoryEntries(directoryPath: string, entries: readonly Dirent[]): Promise<Dirent[]> {
    const visibleEntries: Dirent[] = [];

    for (const entry of entries) {
      const entryPath = normalizePath(path.join(directoryPath, entry.name));
      const ignored = await this.shouldIgnorePath(entryPath, entry.isDirectory());
      if (!ignored) {
        visibleEntries.push(entry);
      }
    }

    return visibleEntries;
  }

  async shouldIgnorePath(candidatePath: string, isDirectory: boolean): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const normalizedCandidate = normalizePath(path.resolve(candidatePath));
    const parentDirectory = normalizePath(path.dirname(normalizedCandidate));
    const matcherContexts = await this.getMatcherContexts(normalizedCandidate, parentDirectory);
    let ignored = false;

    for (const context of matcherContexts) {
      const relativePath = normalizeIgnoreRelativePath(
        context.baseDirectory,
        normalizedCandidate,
        isDirectory,
      );
      if (!relativePath) {
        continue;
      }

      const testResult = context.matcher.test(relativePath) as IgnoreTestResult;
      if (testResult.unignored) {
        ignored = false;
      } else if (testResult.ignored) {
        ignored = true;
      }
    }

    return ignored;
  }

  private async loadExplicitMatchers(): Promise<void> {
    for (const spec of this.explicitSpecs) {
      const matcher = await this.loadMatcher(spec.filePath);
      if (!matcher) {
        throw new Error(`Ignore file not found or unreadable: ${spec.filePath}`);
      }
    }
  }

  private async getMatcherContexts(
    candidatePath: string,
    parentDirectory: string,
  ): Promise<MatcherContext[]> {
    const contexts: MatcherContext[] = [];

    for (const spec of this.explicitSpecs) {
      if (!isWithinOrSame(candidatePath, spec.baseDirectory)) {
        continue;
      }

      const matcher = await this.loadMatcher(spec.filePath);
      if (!matcher) {
        continue;
      }

      contexts.push({
        baseDirectory: spec.baseDirectory,
        order: spec.order,
        matcher,
      });
    }

    const owningRoot = this.findOwningRoot(candidatePath);
    if (!owningRoot) {
      return contexts.sort(compareMatcherContexts);
    }

    const ancestorDirectories = getAncestorDirectories(owningRoot, parentDirectory);
    for (const directory of ancestorDirectories) {
      for (const spec of this.discoverableSpecs) {
        const filePath = normalizePath(path.join(directory, spec.value));
        const matcher = await this.loadMatcher(filePath);
        if (!matcher) {
          continue;
        }

        contexts.push({
          baseDirectory: directory,
          order: spec.order,
          matcher,
        });
      }
    }

    return contexts.sort(compareMatcherContexts);
  }

  private findOwningRoot(candidatePath: string): string | null {
    let bestMatch: string | null = null;

    for (const allowedRoot of this.allowedRoots) {
      if (!isWithinOrSame(candidatePath, allowedRoot)) {
        continue;
      }

      if (!bestMatch || allowedRoot.length > bestMatch.length) {
        bestMatch = allowedRoot;
      }
    }

    return bestMatch;
  }

  private async loadMatcher(filePath: string): Promise<Ignore | null> {
    const normalizedFilePath = normalizePath(path.resolve(this.cwd, filePath));
    if (this.matcherCache.has(normalizedFilePath)) {
      return this.matcherCache.get(normalizedFilePath) ?? null;
    }

    try {
      const fileContent = await fs.readFile(normalizedFilePath, "utf-8");
      const matcher = ignore();
      matcher.add(fileContent);
      this.matcherCache.set(normalizedFilePath, matcher);
      return matcher;
    } catch {
      this.matcherCache.set(normalizedFilePath, null);
      return null;
    }
  }
}

function compareMatcherContexts(left: MatcherContext, right: MatcherContext): number {
  const lengthDifference = left.baseDirectory.length - right.baseDirectory.length;
  if (lengthDifference !== 0) {
    return lengthDifference;
  }

  return left.order - right.order;
}
