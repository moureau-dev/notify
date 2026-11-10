# Security

`notify` is designed to be deployed on the public internet with source code that anyone can read. Security does not rely on hidden endpoints or default secrets.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Email the maintainer or use GitHub's private vulnerability reporting for this repository. Include:

- affected version or commit,
- reproduction steps,
- impact,
- any suggested fix.

You will get an acknowledgement and a coordinated disclosure timeline.

## Threat model

Assume an attacker can:

- read every route, schema, default, and error message,
- reach `/`, `/api/*`, and `/mcp` over the network,
- submit arbitrary JSON, headers, cookies, and push subscription values,
- enroll a device only with a valid one-time enrollment token,
- use a stolen API token until it is revoked.

Assume an attacker cannot:

- read the database or volume,
- read server environment variables or secrets,
- modify the deployed image or host.

Out of scope: host compromise, malicious maintainers, browser or push-service compromise, denial of service that exceeds the host's capacity.

## Security invariants

- No default credentials and no unauthenticated setup endpoint.
- If no API tokens exist, the server refuses to start without `NOTIFY_BOOTSTRAP_TOKEN`.
- `/api/*` and `/mcp` require Bearer tokens. Missing/invalid tokens get `401`; missing scopes get `403`.
- Admin MCP tools are hidden unless `MCP_ADMIN_ENABLED=1` and are still scope-gated.
- Tokens are high-entropy, hashed at rest, shown once, revocable, and optionally expiring.
- Channel-scoped tokens cannot read, send to, enroll into, or manage another channel.
- Device cookies are HttpOnly, SameSite=Strict, Secure on HTTPS, and only manage that device.
- Enrollment tokens are single-use, short-lived, high-entropy, and stripped from the URL after load.
- Push endpoints must be HTTPS, use the default port, contain no credentials, and match the push host allowlist. This blocks SSRF through subscription endpoints.
- Notification URLs must be HTTPS in production; the service worker never injects HTML.
- All SQL uses prepared statements. Static files are served from an allowlist.
- Request bodies are size-limited; auth, enrollment, sends, and MCP calls are rate-limited.
- Security headers include CSP, HSTS on HTTPS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`.
- No CORS by default.
- Logs redact Authorization headers, cookies, tokens, push keys, and endpoints.
- Sensitive actions are recorded in `audit_events` without secrets.

## Bootstrap and token hygiene

1. Generate VAPID keys with `notify vapid generate`; store the private key as a secret.
2. Set `NOTIFY_BOOTSTRAP_TOKEN` to at least 32 random characters for the first boot.
3. Create a named admin token with `notify token create --name admin --scope admin`.
4. Create purpose-specific tokens: `notify:send` for agents, `devices:write` for enrollment automation.
5. Revoke `bootstrap` and remove `NOTIFY_BOOTSTRAP_TOKEN` after the first deploy.
6. Rotate tokens on suspicion; revocation is immediate.

Do not give AI agents an admin token. Prefer a send-only token.

## Deployment hardening

- Bare metal / self-host: keep `HOST=127.0.0.1` and run a reverse proxy on the same host. Do not expose Bun directly.
- Containers: `0.0.0.0` is correct inside the container, but publish the port only through a TLS proxy (or bind the published port to loopback, e.g. `127.0.0.1:8787:8787`).
- Set `TRUST_PROXY=true` only when a trusted reverse proxy sets `X-Forwarded-*`.
- Run the container non-root, read-only, with all capabilities dropped and `no-new-privileges`.
- `serve --tailscale` binds the app to loopback and creates a tailnet-only Serve proxy. It never uses public Funnel. Use `--tailscale-port` to avoid replacing an existing handler, and let it clean up on exit unless you explicitly pass `--tailscale-keep`.
- Keep `/data` private; it contains hashed tokens and push subscription material.
- Back up `/data/notify.sqlite` as sensitive data.
- Keep dependencies updated; CI runs tests, typecheck, secret scanning, and `bun audit`.

## Known limitations

- Single-node SQLite. Do not run multiple replicas against the same database.
- Rate limits are in memory and reset on restart.
- No multi-tenant account system. Scoping is channel-based, not user-account-based.
- No mTLS or service mesh; rely on TLS termination at the reverse proxy and the application’s own authentication.
- Web Push delivery is best-effort. The delivery log records outcomes but there is no retry queue.
