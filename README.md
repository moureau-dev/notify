# notify

Self-hosted Web Push notifications with three interfaces over one Bun process:

- **HTTP API** for the PWA, CLI, and automation.
- **CLI** for registration, sending, and administration.
- **MCP** for AI agents that need to notify a human when work finishes.

One Bun process, one SQLite database, one Docker image. No Redis, no broker, no worker container.

```
Browser/PWA ── HTTP ─┐
CLI ──────── HTTP ───┤
MCP clients ─ HTTP ───┼── Bun.serve ── core services ── SQLite
                      │                            └── Web Push
                      └── /mcp
```

## Quick start (local)

```bash
bun install

cp .env.example .env
# edit .env
```

From a checkout, either prefix commands with `bun run src/index.ts`, or link the CLI once so the `notify` examples below work:

```bash
bun link
notify --help
```

The example keeps `HOST=127.0.0.1` and stores the database at `./data/notify.sqlite`. That is the safe default for self-hosting. Put a reverse proxy on the same host if you need a public hostname.

Generate VAPID keys once:

```bash
bun run src/index.ts vapid generate
```

Put the three printed lines in `.env`. Use a real contact URI for `VAPID_SUBJECT` (`https://your-domain` or `mailto:you@your-domain`); Apple rejects localhost and example values.

Uncomment `NOTIFY_BOOTSTRAP_TOKEN` in `.env` and set it to at least 32 random characters:

```bash
openssl rand -base64 32
```

Start the server:

```bash
bun run src/index.ts serve --dev
```

On iPhone, Web Push only works after adding the page to the Home Screen (Share → Add to Home Screen). Safari tabs cannot subscribe.

In another terminal, use the bootstrap token:

```bash
export NOTIFY_URL=http://127.0.0.1:8787
export NOTIFY_TOKEN='<your bootstrap token>'

bun run src/index.ts channel list
bun run src/index.ts register --channel alice --label "MacBook Chrome"
```

Open the printed enrollment URL on the device, grant notification permission, and send a test:

```bash
bun run src/index.ts send "Hello from notify" --channel alice
```

### Create a real token and retire bootstrap

```bash
bun run src/index.ts token create --name admin --scope admin
# save the printed token, then
bun run src/index.ts token revoke bootstrap
```

Use a separate send-only token for agents:

```bash
bun run src/index.ts token create --name agent --scope notify:send
```

## Docker

A public image is published to GHCR by `.github/workflows/publish.yml` when you publish a GitHub release (and on manual dispatch):

```bash
docker pull ghcr.io/moureau-dev/notify:latest
docker pull ghcr.io/moureau-dev/notify:0.1.0
```

The workflow builds `linux/amd64` and `linux/arm64`, emits an SBOM, and tags the release (`0.1.0`, `0.1`, `0`, `v0.1.0`, `latest`, and `sha-...`). If you fork the repo, the image is `ghcr.io/<your-owner>/notify`; if GHCR leaves the package private, set Packages → notify → Package settings → Change visibility → Public.

This is the local Docker path. For a public hostname, see [Deployment](#deployment).

```bash
cp .env.example .env
# set VAPID_* and NOTIFY_BOOTSTRAP_TOKEN
docker compose up -d --build
```

Compose publishes `127.0.0.1:8787:8787`, not every interface. Change the port mapping only if you understand the exposure, or put a TLS reverse proxy in front.

The database lives in the `notify-data` volume at `/data/notify.sqlite`. Compose overrides `HOST=0.0.0.0` and `DATABASE_PATH=/data/notify.sqlite` for the container; `.env` stays written for bare-metal self-hosting. The container runs as a non-root user with a read-only root filesystem (except `/data` and `/tmp`). For a public hostname, put the container behind a TLS reverse proxy and set `PUBLIC_URL` to the `https://` URL.

## Tailscale helper (optional)

For local or phone testing without certificates, `serve` can create a tailnet-only HTTPS proxy:

```bash
PORT=8890 notify serve --tailscale
```

It:

- detects the Tailscale CLI and MagicDNS name,
- sets `PUBLIC_URL` to `https://<magicdns>:8443`,
- binds the Bun server to `127.0.0.1`,
- runs `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`,
- removes the proxy on Ctrl-C (unless `--tailscale-keep`).

Options:

```bash
--tailscale-port 8443   # HTTPS port on the tailnet
--tailscale-force       # replace an existing handler on that port
--tailscale-keep        # leave the proxy after the server exits
```

It is tailnet-only (`tailscale serve`), never public Funnel. If 8443 is busy, pick another port. If Tailscale is not installed or HTTPS/MagicDNS is disabled, it fails with an explanation instead of starting a half-configured server.

## Deployment

`docker compose up -d --build` is the reference deployment. It sets `HOST=0.0.0.0` and `DATABASE_PATH=/data/notify.sqlite` inside the container, publishes only `127.0.0.1:8787`, and persists `/data`.

For a public hostname:

1. Set `NODE_ENV=production` and `PUBLIC_URL=https://notify.example.com`.
2. Terminate TLS in Caddy, nginx, Traefik, or Cloudflare Tunnel.
3. Set `TRUST_PROXY=true` only when that proxy is trusted.
4. Proxy to `127.0.0.1:8787`. The proxy must run on the host (or share a Docker network with the container); `127.0.0.1` is not reachable from another container.
5. Supply `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `NOTIFY_BOOTSTRAP_TOKEN` from your secret manager.
6. Back up `/data`; it contains the SQLite database, token hashes, and push subscriptions.

Need tailnet-only access instead of a public hostname? Use `notify serve --tailscale` and skip the public proxy.

Web Push requires the public HTTPS origin to match `PUBLIC_URL`.

## CLI

```bash
notify serve [--dev] [--tailscale] [--tailscale-port 8443] [--tailscale-force] [--tailscale-keep]
notify vapid generate [--json]
notify login --url <url> --token <token>

notify register [--channel <slug>] [--label <label>] [--ttl 15m] [--no-create] [--json]
notify send <message> [--title <title>] [--channel <slug>] [--link <url>] [--tag <tag>] [--json]

notify channel list|create|delete|set-default
notify device list
notify subscription list|remove
notify notifications list|show
notify setup
notify token list|create|revoke
notify doctor
```

`register --channel alice` uses get-or-create when authenticated with a global token. A channel-scoped token can only enroll into its own channel and cannot create channels. `--ttl` accepts `15m`, `24h`, or `7d` (minimum 1m, maximum 24h); the HTTP API takes the same value as `ttlMs`.

`subscription list` shows the subscription IDs used by `subscription remove`. `notifications show <id>` prints the stored notification and every delivery attempt.

`notify setup` verifies the server/token and prints a portable contract: MCP URL, auth shape, OpenCode config, Claude Code command, and the live tool list. Use `--json` for agents.

Environment: `NOTIFY_URL`, `NOTIFY_TOKEN`. Config: `~/.config/notify/config.json` (or `NOTIFY_CONFIG`).

## MCP

The endpoint is `POST /mcp` on the same host. It uses Bearer authentication and per-tool scopes.

Agents do not need the commands hardcoded: after connecting, they call `tools/list` and receive tool names, descriptions, and JSON input schemas. You still configure the URL and `Authorization` header per client. Any client that supports remote Streamable HTTP MCP with custom headers works; stdio-only clients need a bridge, and OAuth-only clients without custom headers cannot use static Bearer tokens. Autocompletion, when a client offers it, is driven by those schemas.

`notify setup --json` prints a portable contract, and the running server serves a plain-text agent contract at `/llms.txt`. Repo-level guidance for coding agents is in [AGENTS.md](./AGENTS.md) and [llms.txt](./llms.txt).

Tools:

| Tool | Scope | Admin gate |
|---|---|---|
| `notify` | `notify:send` | no |
| `list_channels` | `channels:read` | no |
| `list_devices` | `devices:read` | no |
| `list_notifications` | `notify:read` | no |
| `create_channel` | `channels:write` | `MCP_ADMIN_ENABLED=1` |
| `register_device` (`ttlMs` optional, returns URL + QR) | `devices:write` | `MCP_ADMIN_ENABLED=1` |
| `manage_subscription` | `devices:write` | `MCP_ADMIN_ENABLED=1` |

Admin tools are not registered unless `MCP_ADMIN_ENABLED=1`, and even then they require the right scope. Give agents a `notify:send` token, not the admin token. `list_devices` includes subscription IDs so an agent can call `manage_subscription`.

OpenCode example:

```json
{
  "mcp": {
    "notify": {
      "type": "remote",
      "url": "https://notify.example.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer ntk_..."
      }
    }
  }
}
```

Claude Code example:

```bash
claude mcp add --transport http notify https://notify.example.com/mcp \
  --header "Authorization: Bearer ntk_..."
```

The MCP server is stateless and uses the Streamable HTTP transport. A stdio-only client needs a bridge; none is included in v1.

## HTTP API

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | public |
| GET | `/api/config` | public |
| GET | `/enroll?token=...` | public page (token in URL) |
| POST | `/api/enroll` | one-time enrollment token |
| GET | `/api/subscriptions/me` | device cookie |
| DELETE | `/api/subscriptions/me/:id` | device cookie |
| POST | `/api/subscriptions/me/test` | device cookie |
| POST | `/api/notify` | `notify:send` |
| GET | `/api/notifications` | `notify:read` |
| GET | `/api/notifications/:id` | `notify:read` |
| GET | `/llms.txt` | public |
| GET/POST | `/api/channels` | `channels:read` / `channels:write` |
| DELETE | `/api/channels/:slug` | `channels:write` |
| POST | `/api/channels/:slug/default` | `channels:write` |
| POST | `/api/enrollments` | `devices:write` |
| GET | `/api/devices` | `devices:read` |
| GET | `/api/subscriptions` | `devices:read` |
| DELETE | `/api/subscriptions/:id` | `devices:write` |
| GET/POST | `/api/tokens` | `admin` |
| DELETE | `/api/tokens/:id` | `admin` |
| POST | `/mcp` | Bearer + per-tool scope |

Scopes: `notify:send`, `notify:read`, `channels:read`, `channels:write`, `devices:read`, `devices:write`, `admin`. Tokens are stored as hashes and shown once.

Creating or deleting channels requires a global token; channel-scoped tokens are read/enroll/send-only within their channel. `POST /api/enrollments` accepts `ttlMs` from `60000` to `86400000`.

## Data and migrations

SQLite uses WAL, foreign keys, and a busy timeout. Migrations are pure SQL files:

```
src/db/migrations/
├── 0001_initial_schema.up.sql
└── 0002_example.up.sql
```

The runner creates `_migrations`, reads `*.up.sql` files in alphabetical order, skips already-applied files, executes each in a transaction, and records it. Never edit a migration that has run in production; add a new one.

Tables: `channels`, `devices`, `subscriptions`, `enrollment_tokens`, `api_tokens`, `notifications`, `deliveries`, `audit_events`.

Every send creates a `notifications` row, even when the channel has no subscriptions. Each subscription attempt creates a `deliveries` row with status (`sent`, `failed`, `expired`), HTTP status code, and error. `RETENTION_DAYS` (default 90) prunes old notifications, deliveries, and audit rows.

A device can have subscriptions in multiple channels. A channel-scoped token is restricted to one channel; a global token can act across channels.

## Security

- No default credentials. The first boot fails closed without `NOTIFY_BOOTSTRAP_TOKEN`.
- API and MCP requests require Bearer tokens. `/mcp` requires a valid token before tool discovery.
- Admin MCP tools are opt-in and scope-gated.
- Device management uses an HttpOnly, SameSite=Strict cookie; no device token in localStorage.
- Enrollment tokens are high-entropy, single-use, short-lived, and stripped from the URL.
- Push endpoints are HTTPS-only, host-allowlisted, and validated for key sizes (SSRF protection).
- Notification URLs are scheme-validated; the service worker never injects HTML.
- CSP, HSTS (on HTTPS), no CORS, no directory listing, body limits, and auth/send rate limits.
- Tokens and push endpoints are redacted from logs. Sensitive actions are audited.
- Production refuses to bind a public host over plaintext HTTP.
- The image runs as a non-root user; the compose file adds a read-only root filesystem.

See [SECURITY.md](./SECURITY.md) for the threat model and disclosure process.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
bun run build
```

`bun run src/index.ts serve --dev` generates a persistent development VAPID keypair at `data/dev-vapid.json` if real keys are not configured. Do not use those keys in production.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for migration and test conventions.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). Release notes are written from the matching version section.

## License

MIT. See [LICENSE](./LICENSE).
