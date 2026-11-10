import type { DB } from "../db";
import { audit } from "./audit";
import {
  API_TOKEN_PREFIX,
  createOpaqueToken,
  parseOpaqueToken,
  safeEqual,
  sha256Hex,
} from "./crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { SCOPES, type AuthContext } from "./types";

export interface ApiTokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  channel_id: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface CreatedApiToken {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  channelId: string | null;
  expiresAt: number | null;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: string[];
  channelId?: string | null;
  expiresAt?: number | null;
  actor?: string | null;
  ip?: string | null;
}

function validateScopes(scopes: string[]): string[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) throw new ValidationError("At least one scope is required");

  for (const scope of unique) {
    if (!(SCOPES as readonly string[]).includes(scope)) {
      throw new ValidationError(`Unknown scope: ${scope}`);
    }
  }

  return unique;
}

export function createApiToken(db: DB, input: CreateApiTokenInput): CreatedApiToken {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Token name is required");

  const scopes = validateScopes(input.scopes);
  const channelId = input.channelId ?? null;

  if (channelId && scopes.includes("admin")) {
    throw new ValidationError("An admin token cannot be scoped to a single channel");
  }

  if (channelId) {
    const channel = db.query("SELECT id FROM channels WHERE id = ?").get(channelId);
    if (!channel) throw new NotFoundError("Channel not found");
  }

  const opaque = createOpaqueToken(API_TOKEN_PREFIX);
  const now = Date.now();

  db.query(
    `INSERT INTO api_tokens (id, name, token_hash, scopes, channel_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opaque.id,
    name,
    opaque.hash,
    scopes.join(" "),
    channelId,
    now,
    input.expiresAt ?? null,
  );

  audit(db, {
    actor: input.actor ?? opaque.id,
    action: "token.created",
    target: opaque.id,
    channelId,
    outcome: "success",
    ip: input.ip,
  });

  return {
    id: opaque.id,
    name,
    token: opaque.token,
    scopes,
    channelId,
    expiresAt: input.expiresAt ?? null,
  };
}

export function verifyApiToken(db: DB, token: string): AuthContext | null {
  if (!token || token.length > 1024) return null;

  let row: ApiTokenRow | null = null;
  const parsed = parseOpaqueToken(token, API_TOKEN_PREFIX);

  if (parsed) {
    const candidate = (db.query("SELECT * FROM api_tokens WHERE id = ?").get(parsed.id) as ApiTokenRow | null) ?? null;
    if (candidate && safeEqual(sha256Hex(parsed.secret), candidate.token_hash)) {
      row = candidate;
    }
  }

  if (!row) {
    row = (db.query("SELECT * FROM api_tokens WHERE token_hash = ?").get(sha256Hex(token)) as ApiTokenRow | null) ?? null;
  }

  if (!row) return null;

  const now = Date.now();
  if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)) return null;

  if (row.last_used_at === null || now - row.last_used_at > 60_000) {
    db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }

  return {
    tokenId: row.id,
    name: row.name,
    scopes: new Set(row.scopes.split(" ").filter(Boolean)),
    channelId: row.channel_id,
    expiresAt: row.expires_at,
  };
}

export function listApiTokens(db: DB): Array<Omit<ApiTokenRow, "token_hash">> {
  return db
    .query(
      `SELECT id, name, scopes, channel_id, created_at, expires_at, revoked_at, last_used_at
       FROM api_tokens ORDER BY created_at DESC`,
    )
    .all() as Array<Omit<ApiTokenRow, "token_hash">>;
}

export function revokeApiToken(
  db: DB,
  id: string,
  actor?: string | null,
  ip?: string | null,
): void {
  const row = db.query("SELECT id, channel_id FROM api_tokens WHERE id = ?").get(id) as
    | { id: string; channel_id: string | null }
    | null;

  if (!row) throw new NotFoundError("Token not found");

  db.query("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id);

  audit(db, {
    actor: actor ?? id,
    action: "token.revoked",
    target: id,
    channelId: row.channel_id,
    outcome: "success",
    ip,
  });
}

export function ensureBootstrapToken(db: DB, bootstrapToken: string | null): void {
  const count = (db.query("SELECT COUNT(*) AS count FROM api_tokens").get() as { count: number }).count;
  if (count > 0) return;

  if (!bootstrapToken) {
    throw new Error(
      "No API tokens exist. Set NOTIFY_BOOTSTRAP_TOKEN (at least 32 characters) for the first boot.",
    );
  }

  if (bootstrapToken.length < 32) {
    throw new Error("NOTIFY_BOOTSTRAP_TOKEN must be at least 32 characters long.");
  }

  db.query(
    `INSERT INTO api_tokens (id, name, token_hash, scopes, channel_id, created_at)
     VALUES ('bootstrap', 'bootstrap', ?, 'admin', NULL, ?)`,
  ).run(sha256Hex(bootstrapToken), Date.now());

  audit(db, {
    actor: "system",
    action: "token.bootstrap_created",
    target: "bootstrap",
    outcome: "success",
  });
}

export function requireGlobal(auth: AuthContext): void {
  if (auth.channelId !== null) {
    throw new ForbiddenError("This operation requires a global token");
  }
}
