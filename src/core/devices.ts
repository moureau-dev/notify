import type { DB } from "../db";
import {
  DEVICE_TOKEN_PREFIX,
  randomToken,
  safeEqual,
  sha256Hex,
} from "./crypto";
import { NotFoundError } from "./errors";
import type { Device } from "./types";

interface DeviceRow {
  id: string;
  label: string;
  user_agent: string | null;
  session_hash: string | null;
  created_at: number;
  last_seen_at: number;
}

export interface DeviceWithSubscriptions extends Device {
  subscriptionCount: number;
  activeSubscriptionCount: number;
}

function mapDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    label: row.label,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function findDeviceById(db: DB, id: string): Device | null {
  const row = db.query("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | null;
  return row ? mapDevice(row) : null;
}

export function createDevice(
  db: DB,
  input: { label?: string | null; userAgent?: string | null },
): Device {
  const now = Date.now();
  const id = `dev_${randomToken(10)}`;
  const label = (input.label?.trim() || input.userAgent?.trim() || "Device").slice(0, 80);

  db.query(
    "INSERT INTO devices (id, label, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, label, input.userAgent?.slice(0, 512) ?? null, now, now);

  return { id, label, userAgent: input.userAgent ?? null, createdAt: now, lastSeenAt: now };
}

export function updateDevice(
  db: DB,
  id: string,
  input: { label?: string | null; userAgent?: string | null },
): Device {
  const device = findDeviceById(db, id);
  if (!device) throw new NotFoundError("Device not found");

  const label = input.label?.trim();
  const now = Date.now();

  db.query(
    `UPDATE devices
     SET label = COALESCE(?, label),
         user_agent = COALESCE(?, user_agent),
         last_seen_at = ?
     WHERE id = ?`,
  ).run(label ? label.slice(0, 80) : null, input.userAgent?.slice(0, 512) ?? null, now, id);

  return findDeviceById(db, id) as Device;
}

export function touchDevice(db: DB, id: string): void {
  db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
}

export function rotateDeviceSession(db: DB, deviceId: string): string {
  const secret = randomToken(32);
  const token = `${DEVICE_TOKEN_PREFIX}_${secret}`;
  db.query("UPDATE devices SET session_hash = ? WHERE id = ?").run(sha256Hex(secret), deviceId);
  return token;
}

export function clearDeviceSession(db: DB, deviceId: string): void {
  db.query("UPDATE devices SET session_hash = NULL WHERE id = ?").run(deviceId);
}

export function verifyDeviceToken(db: DB, token: string): Device | null {
  if (!token || token.length > 1024) return null;
  if (!token.startsWith(`${DEVICE_TOKEN_PREFIX}_`)) return null;

  const secret = token.slice(DEVICE_TOKEN_PREFIX.length + 1);
  if (!secret) return null;

  const row = db.query("SELECT * FROM devices WHERE session_hash = ?").get(sha256Hex(secret)) as
    | DeviceRow
    | null;
  if (!row || !row.session_hash) return null;
  if (!safeEqual(sha256Hex(secret), row.session_hash)) return null;

  touchDevice(db, row.id);
  return mapDevice(row);
}

export function listDevices(db: DB, channelId?: string | null): DeviceWithSubscriptions[] {
  const rows = channelId
    ? (db
        .query(
          `SELECT d.*,
                  COUNT(s.id) AS subscription_count,
                  SUM(CASE WHEN s.disabled_at IS NULL THEN 1 ELSE 0 END) AS active_subscription_count
           FROM devices d
           JOIN subscriptions s ON s.device_id = d.id AND s.channel_id = ?
           GROUP BY d.id
           ORDER BY d.last_seen_at DESC`,
        )
        .all(channelId) as Array<DeviceRow & { subscription_count: number; active_subscription_count: number }>)
    : (db
        .query(
          `SELECT d.*,
                  COUNT(s.id) AS subscription_count,
                  SUM(CASE WHEN s.disabled_at IS NULL THEN 1 ELSE 0 END) AS active_subscription_count
           FROM devices d
           LEFT JOIN subscriptions s ON s.device_id = d.id
           GROUP BY d.id
           ORDER BY d.last_seen_at DESC`,
        )
        .all() as Array<DeviceRow & { subscription_count: number; active_subscription_count: number }>);

  return rows.map((row) => ({
    ...mapDevice(row),
    subscriptionCount: Number(row.subscription_count ?? 0),
    activeSubscriptionCount: Number(row.active_subscription_count ?? 0),
  }));
}
