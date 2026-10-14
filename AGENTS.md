# AGENTS.md

## Checks

- Run `bun run format:check`, `bun run lint`, `bun run typecheck` and `bun run test`
  before committing (`bun run format` fixes formatting). CI runs all four on every
  push and pull request.
- The typecheck is TypeScript 7, `tsc -b` over every project in `tsconfig.json`:
  `tsconfig.app.json` covers `src/` and `tsconfig.scripts.json` covers `scripts/`.
  A new directory of TypeScript needs a project there. `src/` is not yet checked in
  strict mode.
- Formatting is oxfmt (`.oxfmtrc.json`).

## Lint and complexity policy

- Lint is oxlint (`.oxlintrc.json`), run through `scripts/lint.ts`. It enforces
  `complexity`, capped at 10 per function (the repo is clean at that threshold), and
  the type-aware rules from typescript-eslint's recommended-type-checked set, which
  oxlint runs through `oxlint-tsgolint`. Warnings fail too.
- `lint-suppressions.json` records violations of the type-aware rules that existed
  when they were introduced, as file → rule → count. A new violation fails, and so
  does a recorded count that is higher than the file needs: after fixing one, run
  `bun run lint:prune` and commit the file. Never raise a count.
- Prefer splitting a function over adding `// oxlint-disable-next-line complexity`.
  If a disable really is the right call (a table-driven or numeric routine where the
  branches are the point), put the reason on the line above it.
