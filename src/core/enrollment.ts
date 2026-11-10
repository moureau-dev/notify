import type { DB } from "../db";
import { audit } from "./audit";
import { ENROLLMENT_TOKEN_PREFIX, createOpaqueToken, parseOpaqueToken, safeEqual, sha256Hex } from "./crypto";
import { ValidationError } from "./errors";

interface EnrollmentRow {
  id: string;
  token_hash: string;
  channel_id: string;
  label: string | null;
  expires_at: number;
  used_at: number | null;
  created_at: number;
  created_by: string | null;
}

export interface CreatedEnrollment {
  id: string;
  token: string;
  url: string;
  expiresAt: number;
  channelId: string;
}

export interface ConsumedEnrollment {
  id: string;
  channelId: string;
  label: string | null;
}

export function createEnrollment(
  db: DB,
  input: {
    channelId: string;
    label?: string | null;
    ttlMs?: number;
    publicUrl: string;
    createdBy?: string | null;
    actor?: string | null;
    ip?: string | null;
  },
): CreatedEnrollment {
  const opaque = createOpaqueToken(ENROLLMENT_TOKEN_PREFIX);
  const now = Date.now();
  const expiresAt = now + (input.ttlMs ?? 15 * 60 * 1000);

  db.query(
    `INSERT INTO enrollment_tokens
      (id, token_hash, channel_id, label, expires_at, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opaque.id,
    opaque.hash,
    input.channelId,
    input.label?.trim()?.slice(0, 80) || null,
    expiresAt,
    now,
    input.createdBy ?? null,
  );

  audit(db, {
    actor: input.actor ?? input.createdBy,
    action: "enrollment.created",
    target: opaque.id,
    channelId: input.channelId,
    outcome: "success",
    ip: input.ip,
  });

  const url = `${input.publicUrl}/enroll?token=${encodeURIComponent(opaque.token)}`;

  return {
    id: opaque.id,
    token: opaque.token,
    url,
    expiresAt,
    channelId: input.channelId,
  };
}

export function consumeEnrollment(
  db: DB,
  token: string,
  options: { ip?: string | null } = {},
): ConsumedEnrollment {
  const parsed = parseOpaqueToken(token, ENROLLMENT_TOKEN_PREFIX);
  if (!parsed) throw new ValidationError("Invalid or expired enrollment link");

  const row = db.query("SELECT * FROM enrollment_tokens WHERE id = ?").get(parsed.id) as
    | EnrollmentRow
    | null;

  if (!row) throw new ValidationError("Invalid or expired enrollment link");
  if (!safeEqual(sha256Hex(parsed.secret), row.token_hash)) {
    throw new ValidationError("Invalid or expired enrollment link");
  }
  if (row.used_at !== null) throw new ValidationError("Invalid or expired enrollment link");
  if (row.expires_at <= Date.now()) throw new ValidationError("Invalid or expired enrollment link");

  const now = Date.now();
  const result = db
    .query("UPDATE enrollment_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .run(now, row.id);

  if (result.changes !== 1) throw new ValidationError("Invalid or expired enrollment link");

  audit(db, {
    actor: row.created_by,
    action: "enrollment.used",
    target: row.id,
    channelId: row.channel_id,
    outcome: "success",
    ip: options.ip,
  });

  return {
    id: row.id,
    channelId: row.channel_id,
    label: row.label,
  };
}
