# Upstream Reference

This repository is derived from the official Model Context Protocol servers repository:

- Upstream repo: `https://github.com/modelcontextprotocol/servers`
- Upstream package path: `src/filesystem`
- Upstream package version observed at extraction: `0.6.3`
- Upstream repo head observed on March 25, 2026: `f4244583a6af9425633e433a3eec000d23f4e011`

## Why This Fork Exists

The upstream filesystem MCP server is useful as-is, but developer workspaces often need ignore-aware listing and traversal. This standalone fork keeps the upstream filesystem server package isolated so it can be maintained and published independently while adding opt-in ignore-file filtering.

## Local-Only Fork Files

These files do not come from upstream `src/filesystem` and should be preserved intentionally during sync work:

- `ignore-manager.ts`
- `CONTRIBUTING.md`
- `UPSTREAM.md`
- standalone package metadata changes in `package.json`
- README sections covering ignore support, npm publishing, and sync workflows
- ignore-related tests

## Recommended Sync Workflow

Use a replay-based subtree sync instead of rebasing this repo directly onto the upstream monorepo.

### One-Time Setup

```bash
git remote add upstream https://github.com/modelcontextprotocol/servers.git
git fetch upstream
```

### Sync Procedure

```bash
git switch -c codex/upstream-sync-YYYYMMDD
tmpdir="$(mktemp -d)"
git clone --filter=blob:none --no-checkout https://github.com/modelcontextprotocol/servers.git "$tmpdir/servers"
git -C "$tmpdir/servers" sparse-checkout init --cone
git -C "$tmpdir/servers" sparse-checkout set src/filesystem
git -C "$tmpdir/servers" checkout upstream/main || git -C "$tmpdir/servers" checkout main
diff -ru "$tmpdir/servers/src/filesystem" .
```

After comparing:

1. Replay relevant upstream changes into this repo root.
2. Preserve fork-specific ignore support and standalone publishing docs intentionally.
3. Resolve conflicts by preferring upstream behavior for untouched areas and preserving fork behavior only where it is an intentional divergence.
4. Run `npm run build` and `npm test`.
5. Update this file with the imported upstream commit SHA and a short note about important behavior changes.

## Conflict Rules

- Treat `index.ts`, `lib.ts`, and ignore-related tests as likely conflict hotspots.
- Preserve tool schemas and default behavior unless upstream intentionally changed them.
- Re-check anything touching directory listing, traversal, or search because that is where ignore-aware filtering hooks in.
