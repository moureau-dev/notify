import type { DB } from "../db";
import { randomToken } from "./crypto";

export interface AuditEvent {
  actor?: string | null;
  action: string;
  target?: string | null;
  channelId?: string | null;
  outcome: string;
  ip?: string | null;
}

export function audit(db: DB, event: AuditEvent): void {
  db.query(
    `INSERT INTO audit_events (id, actor, action, target, channel_id, outcome, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomToken(12),
    event.actor ?? null,
    event.action,
    event.target ?? null,
    event.channelId ?? null,
    event.outcome,
    event.ip ?? null,
    Date.now(),
  );
}
