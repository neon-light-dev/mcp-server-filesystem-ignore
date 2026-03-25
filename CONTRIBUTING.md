# Contributing

## Local Development

```bash
npm install
npm test
npm run build
```

## PR Expectations

- Keep changes small and readable.
- Preserve upstream behavior unless the change is part of this fork’s documented ignore support.
- Add or update tests for any change that touches listing, traversal, search, path normalization, or path validation.
- Document user-visible behavior changes in `README.md`.
- If you change publish behavior, keep `.github/workflows/publish.yml` and the npm trusted-publisher instructions in sync.

## Upstream Sync Expectations

- Follow the replay-based sync workflow in [`UPSTREAM.md`](./UPSTREAM.md).
- Prefer importing upstream changes cleanly rather than restructuring this repo.
- Keep the repo root aligned with upstream `src/filesystem` where practical so future comparisons stay mechanical.

## AI-Agent Sync PR Expectations

When assigning an AI agent to prepare an upstream sync PR, ask it to:

1. Fetch upstream changes.
2. Create a `codex/upstream-sync-...` branch.
3. Compare upstream `src/filesystem` to this repo root.
4. Replay upstream changes while preserving the fork’s ignore manager and standalone metadata.
5. Run `npm run build` and `npm test`.
6. Produce a concise summary of conflicts, behavior changes, and review risks.
