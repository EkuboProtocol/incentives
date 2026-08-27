# AGENTS.md

## Complexity Policy
- Run `bun run lint` before committing. CI runs it on every push and pull request.
- The only rule is ESLint's `complexity`, capped at 10 per function. The repo is clean
  at that threshold today.
- Prefer splitting a function over adding `// eslint-disable-next-line complexity`.
  If a disable really is the right call (a table-driven or numeric routine where the
  branches are the point), put the reason on the line above it.
