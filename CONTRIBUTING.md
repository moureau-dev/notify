# Contributing

## Setup

```bash
bun install
cp .env.example .env
bun run src/index.ts vapid generate
# put the keys in .env and set NOTIFY_BOOTSTRAP_TOKEN
bun run src/index.ts serve --dev
```

## Checks

```bash
bun test
bunx tsc --noEmit
bun run build
bun audit --audit-level=high
```

All four must pass before a pull request.

## Migrations

Migrations are pure SQL files under `src/db/migrations/`, named `{number}_{description}.up.sql` and sorted alphabetically. The runner tracks executed files in `_migrations`.

- Add a new file; do not edit one that has run in production.
- Wrap dependent statements in one file so the runner's transaction applies them together.
- Add indexes for columns used by lookups or ordering.
- Use prepared statements in application code; never interpolate user input into SQL.

## Code conventions

- Bun + TypeScript, ESM.
- No framework for the server unless there is a strong reason; `Bun.serve` is intentional.
- Core services are framework-agnostic and take a `DB` plus explicit inputs.
- HTTP, CLI, and MCP are adapters over the same core.
- Keep secrets out of logs, errors, and MCP results.
- Add or update tests for behavior changes, especially auth, scopes, enrollment, and delivery.
- Do not add dependencies without a clear need.

## Security

Read [SECURITY.md](./SECURITY.md). Changes touching auth, tokens, enrollment, push validation, headers, or MCP scopes need an explicit test for the denial path.
