# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes yet._

## [0.1.1] - 2026-11-11

### Added

- MCP `register_device` now returns a terminal QR code and a PNG preview alongside the enrollment URL.

### Fixed

- The CLI now honors the saved `~/.config/notify/config.json` URL when `NOTIFY_URL` is not set.

## [0.1.0] - 2026-11-10

### Added

- Single-process Bun + TypeScript service with HTTP API, CLI, and MCP over one SQLite database.
- Web Push delivery with VAPID keys, subscription validation, expired-subscription cleanup, and delivery records.
- PWA enrollment and device management, including one-time enrollment links and terminal QR codes.
- Channels with a default channel, get-or-create enrollment, and channel-scoped API tokens.
- Token authentication with hashed storage, scopes, expiry, revocation, bootstrap, and device cookies.
- MCP Streamable HTTP endpoint with `notify`, `list_channels`, `list_devices`, and `list_notifications`.
- Admin-gated MCP tools: `create_channel`, `register_device`, and `manage_subscription`.
- CLI: `serve`, `vapid generate`, `login`, `send`, `register --ttl`, `channel`, `device`, `subscription`, `notifications list|show`, `token`, `doctor`, and `setup`.
- `serve --tailscale` helper for tailnet-only HTTPS with cleanup on exit.
- Agent contract at `/llms.txt` and a machine-readable `notify setup --json` contract.
- SQLite migrations as pure SQL files, applied in order and tracked in `_migrations`.
- Notification and delivery history with configurable retention.
- Docker image, Compose file, GHCR publishing on published releases, and CI.
- Documentation: README, SECURITY, CONTRIBUTING, AGENTS, and llms.txt.

### Security

- Fail closed without a bootstrap token; no default credentials.
- Bearer tokens are hashed at rest, scoped, revocable, and optionally expiring.
- Channel-scoped tokens cannot read, send to, or manage other channels.
- Device cookies are HttpOnly, SameSite=Strict, and Secure on HTTPS.
- Enrollment tokens are high-entropy, single-use, short-lived, and stripped from the URL.
- Push endpoints are HTTPS-only and host-allowlisted; notification URLs are scheme-validated.
- CSP, HSTS on HTTPS, no CORS, body limits, rate limits, audit events, and redacted logs.
- Admin MCP tools are hidden unless explicitly enabled and still require scopes.

### Known limitations

- SQLite is single-writer; run one replica per database.
- Rate limits are in memory and reset on restart.
- Web Push delivery is best-effort; there is no retry queue.
- MCP is Streamable HTTP only; stdio-only clients need an external bridge.
- CLI shell completion is not implemented.
- iOS requires the PWA to be installed to the Home Screen for Web Push.

[Unreleased]: https://github.com/moureau-dev/notify/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/moureau-dev/notify/releases/tag/v0.1.1
[0.1.0]: https://github.com/moureau-dev/notify/releases/tag/v0.1.0
