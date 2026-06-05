# Pane

Electron desktop app for managing multiple AI coding agent instances (Claude Code, Codex, Aider, Goose) against git worktrees. Pnpm monorepo: `main/` (Electron main process), `frontend/` (React + Vite), `shared/` (types), `tests/` (Playwright E2E). Read `CLAUDE.md` before starting work — it contains architecture details, implementation status, and critical constraints not repeated here.

## Toolchain

| Action | Command | Authority |
|--------|---------|-----------|
| Dev | `pnpm dev` | package.json (`electron-dev`) |
| Build all | `pnpm build` | package.json |
| Build frontend | `pnpm build:frontend` | frontend/vite.config.ts |
| Build main | `pnpm build:main` | main/tsconfig.json |
| Lint | `pnpm lint` | main/eslint.config.js, frontend/eslint.config.js |
| Type-check | `pnpm typecheck` | tsconfig.json per package |
| Test (E2E) | `pnpm test` | playwright.config.ts |
| Test (CI) | `pnpm test:ci` | playwright.ci.config.ts |
| Test (unit, main) | `pnpm --filter main test` | main/vitest.config.* |
| Setup (fresh clone) | `pnpm run setup` | package.json |
| Generate notices | `pnpm run generate-notices` | scripts/generate-notices.js |

## Boundaries

### NEVER
- NEVER use TypeScript `any` — use `unknown` with type guards instead; `@typescript-eslint/no-explicit-any` is `'error'` in both ESLint configs
- NEVER modify files in `main/dist/` or `frontend/dist/` — they are build artifacts
- NEVER add dependencies without running `pnpm run generate-notices` afterward — the `NOTICES` file must stay in sync

### ASK
- Changing build targets or electron-builder configuration — impacts all platform packaging
- Adding new native dependencies (`.node` binaries) — requires `electron:rebuild` and potentially `asarUnpack` config changes
- Modifying database schema in `main/src/database/migrations/` — dual migration system (TypeScript + SQL)

### ALWAYS
- When changing dependencies, ALWAYS run `pnpm run generate-notices` and commit the updated `NOTICES` file
- When working on frontend UI, ALWAYS consult `guidelines/PROGRESSIVE_DISCLOSURE_AND_UX.md` for design patterns
- When developing on Pane itself using Pane, ALWAYS use `PANE_DIR=~/.pane_test pnpm dev` to avoid clobbering your real data

## Architecture Notes

- IPC is the only communication channel between renderer and main process — no remote modules, no node integration in renderer
- Each AI agent runs in its own `node-pty` process inside a git worktree; sessions are isolated at the filesystem level
- Panel system is extensible: `main/src/services/panels/` has abstract base classes (`AbstractCliManager`, `AbstractAIPanelManager`) for adding new agent types; see `docs/ADDING_NEW_CLI_TOOLS.md`
- Database is SQLite via `better-sqlite3-multiple-ciphers` — synchronous API, no ORM; schema in `main/src/database/migrations/`
- Release script (`scripts/release.js`) bumps version, commits, tags, and pushes; CI builds all platforms from the tag

## Done Means

- `pnpm lint` passes with zero errors
- `pnpm typecheck` passes across all workspaces
- `pnpm build` succeeds (frontend + main + electron package)
- E2E tests pass: `pnpm test`
- If dependencies changed: `NOTICES` file is updated and committed
