# `@neonlightdev/mcp-server-filesystem-ignore`

`@neonlightdev/mcp-server-filesystem-ignore` is a standalone repository and npm package derived from the official Model Context Protocol filesystem server in [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

This fork keeps the upstream filesystem server behavior by default, then adds opt-in ignore-file filtering for:

- `list_directory`
- `list_directory_with_sizes`
- `directory_tree`
- `search_files`

The goal is to make developer workspaces less noisy without changing tool contracts or silently introducing default exclusions.

## What Changed Compared With Upstream

- The package is extracted into its own standalone repo so it can be versioned and published independently.
- Ignore-file filtering is available through CLI startup flags instead of being hardcoded or always enabled.
- Ignore matching is shared across directory listing, traversal, and recursive search through a single ignore manager.
- Multiple ignore files are supported, including `.gitignore`, `.cursorignore`, `.mcpignore`, `.claudeignore`, and custom user-defined files.
- Standalone maintenance docs are included for npm publishing and replay-based upstream syncs.

## Provenance

- Upstream repository: [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers)
- Upstream package path: `src/filesystem`
- Upstream package version observed during extraction: `0.6.3`
- Upstream repository head observed on March 25, 2026: `f4244583a6af9425633e433a3eec000d23f4e011`

See [`UPSTREAM.md`](./UPSTREAM.md) for the recorded baseline and future sync workflow.

## Installation

```bash
npm install -g @neonlightdev/mcp-server-filesystem-ignore
```

You can also run it without a global install:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore /absolute/project/path
```

## Basic Usage

Run the server with one or more allowed directories:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore /absolute/project/path
```

Use MCP roots as usual if your client supports them. Ignore support remains opt-in; if you do not pass ignore-related flags, listing, traversal, and search behave like the upstream filesystem server.

## Ignore-File Support

### CLI Flags

- `--ignore-file <path-or-name>`
- `--respect-gitignore`
- `--`

Examples:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file .gitignore \
  /absolute/project/path
```

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file .gitignore \
  --ignore-file .cursorignore \
  /absolute/project/path
```

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file /absolute/path/to/custom.ignore \
  /absolute/project/path
```

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --respect-gitignore \
  /absolute/project/path
```

### How `--ignore-file` Is Interpreted

- Bare filenames such as `.gitignore`, `.cursorignore`, `.mcpignore`, and `.claudeignore` are treated as discoverable ignore-file names.
- Discoverable names are searched at each allowed root and auto-discovered again in nested directories during traversal.
- Absolute paths, or values that contain `/` or `\\`, are treated as explicit ignore files and resolved once at startup.
- Relative explicit file paths are resolved from the server process working directory.

### Merge And Precedence Rules

- Ignore files are evaluated from ancestor directories to descendant directories.
- If multiple configured ignore files exist in the same directory, CLI order wins last.
- Later rules inside the same ignore file override earlier rules using standard gitignore-style negation semantics.
- Tool-level `excludePatterns` for `directory_tree` and `search_files` remain hard exclusions and still apply after ignore-file matching.

### Supported Syntax Expectations

Ignore files use gitignore-style syntax through the [`ignore`](https://www.npmjs.com/package/ignore) package, including:

- comments
- blank lines
- directory patterns such as `node_modules/`
- glob-style patterns such as `dist/**`
- negation such as `!dist/keep.txt`

### Practical Examples

Hide common build and dependency directories from all supported browse/search operations:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file .gitignore \
  --ignore-file .cursorignore \
  /absolute/project/path
```

Use a shared team-specific ignore file:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file /absolute/team-configs/workspace.ignore \
  /absolute/project/path
```

Pass a custom ignore file name that should be discovered throughout the workspace:

```bash
npx -y @neonlightdev/mcp-server-filesystem-ignore \
  --ignore-file .mcpignore \
  /absolute/project/path
```

## Known Limitations

- This implementation uses gitignore-style matching, but it is not a full Git implementation.
- Git-specific global excludes such as `.git/info/exclude` and `core.excludesFile` are not read unless you pass those files explicitly.
- Git configuration such as `core.ignoreCase` is not modeled.
- Discoverable ignore files are only auto-discovered inside active allowed roots.
- Ignore support only filters enumeration, traversal, and search results. It does not block direct reads or writes to a path you specify explicitly.
- Explicit ignore files are interpreted relative to the directory that contains that ignore file. If you point to an ignore file outside your allowed root, only patterns that still match descendants of that file’s directory will apply.

## Development

```bash
npm install
npm test
npm run build
```

## How To Publish This Package To npm

1. Choose the final npm package name and update `package.json`.
2. If you want a scoped package, use a scope you control such as `@your-scope/mcp-server-filesystem-ignore`.
3. Keep `bin`, `repository`, `bugs`, `homepage`, `license`, and `files` aligned with the final package identity.
4. Choose whether you want manual publishing, GitHub Actions trusted publishing, or both.
5. For a local/manual publish, run `npm login`.
6. Run `npm run build`.
7. Run `npm pack --dry-run` and confirm the tarball only contains `dist` plus the intended docs and license files.
8. For a local/manual publish, run `npm publish --access public`.
9. Verify the published version with `npm view @neonlightdev/mcp-server-filesystem-ignore version`.
10. Verify the package page on npm shows the expected README, license, and install command.
11. Use normal semantic versioning for this fork independently of upstream.

Notes:

- Scoped packages need `--access public` unless your registry defaults already handle it.
- The npm README is pulled from repo-root `README.md`.
- The `files` field should stay intentionally small.

### GitHub Actions Trusted Publishing

This repo includes [`publish.yml`](./.github/workflows/publish.yml) for npm trusted publishing.

The workflow is currently pinned to `actions/checkout@v6` and `actions/setup-node@v6`, which GitHub documents as Node 24-based releases. If you see a Node 20 deprecation warning again, it usually means an older workflow still references `@v4` or `@v5`.

1. Open the package settings on npmjs.com.
2. In the `Trusted Publisher` section, choose `GitHub Actions`.
3. Configure:
   - Organization or user: your GitHub user or org
   - Repository: your GitHub repo name
   - Workflow filename: `publish.yml`
   - Environment name: leave blank unless you add a protected GitHub environment and want npm to require it
4. Confirm the repository is public if you want automatic provenance attestations.
5. After trusted publishing works, optionally restrict token-based publishing in npm package settings.
6. Trigger a release publish by tagging a version and pushing the tag:

```bash
npm version patch
git push origin main --follow-tags
```

Or create the tag explicitly:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow will run `npm ci`, `npm test`, `npm pack --dry-run`, and then `npm publish --access public`.

Trusted publishing notes:

- npm trusted publishing currently requires GitHub-hosted runners.
- npm documents that trusted publishing requires npm CLI `11.5.1` or later and Node `22.14.0` or higher.
- When trusted publishing is used from a public GitHub repository for a public npm package, npm automatically generates provenance for the published package.
- The GitHub Actions pieces need to stay on current majors because older `checkout` and `setup-node` majors still run on Node 20 and trigger the deprecation warning.

## How To Keep This Fork In Sync With Upstream

This repo should be maintained with a replay-based subtree sync, not a literal git rebase onto the upstream monorepo.

1. Record the upstream repo URL, subtree path, and imported commit in [`UPSTREAM.md`](./UPSTREAM.md).
2. Add the upstream remote once:

```bash
git remote add upstream https://github.com/modelcontextprotocol/servers.git
git fetch upstream
```

3. Create a sync branch:

```bash
git switch -c codex/upstream-sync-YYYYMMDD
```

4. Sparse-check out just the upstream filesystem package in a temporary clone or worktree.
5. Compare upstream `src/filesystem` against this repo root.
6. Replay relevant upstream changes into this repo, keeping fork-specific ignore support, docs, and package metadata intentionally.
7. Run tests and rebuild after each conflict batch.
8. Update [`UPSTREAM.md`](./UPSTREAM.md) with the new upstream commit and any important behavior notes.

## How To Assign An AI Agent To Prepare An Upstream Sync PR

Give the agent this workflow:

1. Fetch `upstream/main`.
2. Create `codex/upstream-sync-YYYYMMDD`.
3. Compare upstream `src/filesystem` with this repo root.
4. Replay upstream changes that are relevant to this standalone fork.
5. Preserve the ignore manager, CLI ignore flags, package metadata, and standalone maintenance docs unless upstream now provides equivalent functionality.
6. Run `npm run build` and `npm test`.
7. Produce a PR summary that includes the upstream commit imported, conflicts resolved, tool-behavior changes, and any follow-up risks.

The agent should avoid destructive git commands and treat this repo as a subtree-derived fork, not as a full-history rebase target.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for development expectations and PR guidance.
