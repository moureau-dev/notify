# AGENTS.md

`notify` is a self-hosted Web Push service: one Bun process, one SQLite database, HTTP + CLI + MCP over the same core.

## For coding agents using the running service

The MCP endpoint is `POST /mcp` using Streamable HTTP and a Bearer token:

```
Authorization: Bearer ntk_...
```

Clients discover tools at runtime with `tools/list`; there are no hardcoded commands to learn. The tool JSON Schemas describe every argument.

Prefer a send-only token (`notify:send`) for agents. Do not use the admin token unless the task requires channel/device administration.

Tools:

- `notify` — `{ channel?, title?, body, url?, tag?, data? }`. Omit `channel` for the default channel.
- `list_channels` — visible channels.
- `list_devices` — devices and subscription IDs (no push endpoints).
- `list_notifications` — recent notifications.
- `create_channel` — admin-gated, `channels:write`.
- `register_device` — admin-gated, `devices:write`; returns a one-time enrollment URL and optional `ttlMs`.
- `manage_subscription` — admin-gated, `devices:write`; takes a subscription id and `delete`/`disable`.

MCP is stateless. Clients that only support stdio need a bridge; clients that only support OAuth without custom headers cannot use static Bearer tokens. `GET /llms.txt` on the server exposes the same contract, and `notify setup --json` prints it from the CLI.

Notifications and deliveries are stored in SQLite. Use `notify notifications list` for recent sends and `notify notifications show <id>` for per-subscription delivery results.

## For agents working on this repo

Read `README.md` and `SECURITY.md` first. Security-sensitive areas: auth, tokens, enrollment, push validation, channel scoping, MCP scopes, headers, and rate limits.

Commands:

```bash
bun install
bun test
bunx tsc --noEmit
bun run build
bun audit --audit-level=high

bun run src/index.ts serve --dev
bun run src/index.ts serve --tailscale
bun run src/index.ts vapid generate
bun run src/index.ts register --channel <slug> --label <label> --ttl 24h --json
bun run src/index.ts send "message" --channel <slug> --json
bun run src/index.ts notifications list --json
bun run src/index.ts notifications show <id> --json
bun run src/index.ts subscription list --json
bun run src/index.ts setup --json
bun run src/index.ts token create --name <name> --scope <scope> --json
```

Migrations are pure SQL files in `src/db/migrations/*.up.sql`, applied alphabetically and tracked in `_migrations`. Add a new file; never edit one that has run in production.

Core modules are framework-agnostic and take `DB` plus explicit inputs. HTTP, CLI, and MCP are adapters over the same core. Do not add a dependency without a clear need. Never log tokens, cookies, push keys, or endpoints.
