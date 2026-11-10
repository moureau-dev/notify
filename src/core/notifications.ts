import type { DB } from "../db";
import { audit } from "./audit";
import { mapLimit } from "./concurrency";
import { randomToken } from "./crypto";
import { ValidationError } from "./errors";
import { assertSafeNotificationUrl } from "./push/validate";
import { PushSendError, type PushSender } from "./push/types";
import {
  disableSubscription,
  listActiveSubscriptions,
  markSubscriptionFailure,
} from "./subscriptions";
import type { Channel, NotificationRecord, NotificationResult, Subscription } from "./types";

interface NotificationRow {
  id: string;
  channel_id: string;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
  data_json: string | null;
  source: string;
  sent_count: number;
  failed_count: number;
  created_at: number;
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    body: row.body,
    url: row.url,
    tag: row.tag,
    dataJson: row.data_json,
    source: row.source,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
  };
}

export interface DeliveryRecord {
  id: string;
  notificationId: string;
  subscriptionId: string;
  status: string;
  statusCode: number | null;
  error: string | null;
  attemptedAt: number;
  deviceId: string;
  deviceLabel: string;
  channelSlug: string;
}

export interface NotificationDetail extends NotificationRecord {
  channelSlug: string;
  channelName: string;
  deliveries: DeliveryRecord[];
}

export interface SendNotificationInput {
  channel: Channel;
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
  source?: string;
  subscriptionIds?: string[];
  concurrency?: number;
  allowInsecureUrl?: boolean;
  actor?: string | null;
  ip?: string | null;
}

export async function sendNotification(
  db: DB,
  sender: PushSender,
  input: SendNotificationInput,
): Promise<NotificationResult> {
  const title = input.title.trim();
  const body = input.body.trim();

  if (!title) throw new ValidationError("Notification title is required");
  if (title.length > 200) throw new ValidationError("Notification title is too long");
  if (!body) throw new ValidationError("Notification body is required");
  if (body.length > 3000) throw new ValidationError("Notification body is too long");
  if (input.tag && input.tag.length > 64) throw new ValidationError("Notification tag is too long");

  assertSafeNotificationUrl(input.url, input.allowInsecureUrl ?? false);

  const id = `ntf_${randomToken(12)}`;
  const now = Date.now();
  const source = input.source ?? "api";
  const dataJson = input.data ? JSON.stringify(input.data) : null;

  db.query(
    `INSERT INTO notifications
      (id, channel_id, title, body, url, tag, data_json, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.channel.id, title, body, input.url ?? null, input.tag ?? null, dataJson, source, now);

  const subscriptions = listActiveSubscriptions(db, input.channel.id, input.subscriptionIds);

  if (subscriptions.length === 0) {
    audit(db, {
      actor: input.actor,
      action: "notification.sent",
      target: id,
      channelId: input.channel.id,
      outcome: "no_subscriptions",
      ip: input.ip,
    });

    return {
      notificationId: id,
      channel: input.channel.slug,
      sent: 0,
      failed: 0,
      disabled: 0,
      skipped: true,
    };
  }

  let sent = 0;
  let failed = 0;
  let disabled = 0;

  const results = await mapLimit(
    subscriptions,
    input.concurrency ?? 8,
    async (subscription: Subscription) => {
      const attemptedAt = Date.now();

      try {
        const result = await sender.send(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          {
            title,
            body,
            url: input.url,
            tag: input.tag,
            icon: "/icons/icon-192.png?v=2",
            badge: "/icons/icon-192.png?v=2",
            data: { notificationId: id, channel: input.channel.slug, ...(input.data ?? {}) },
          },
        );

        sent += 1;
        db.query(
          `INSERT INTO deliveries
            (id, notification_id, subscription_id, status, status_code, attempted_at)
           VALUES (?, ?, ?, 'sent', ?, ?)`,
        ).run(randomToken(12), id, subscription.id, result.statusCode, attemptedAt);

        return "sent";
      } catch (error) {
        const pushError = error instanceof PushSendError ? error : null;
        const statusCode = pushError?.statusCode ?? 0;
        const isGone = statusCode === 404 || statusCode === 410;

        if (isGone) {
          disabled += 1;
          disableSubscription(db, subscription.id);
        } else {
          failed += 1;
          markSubscriptionFailure(db, subscription.id);
        }

        db.query(
          `INSERT INTO deliveries
            (id, notification_id, subscription_id, status, status_code, error, attempted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomToken(12),
          id,
          subscription.id,
          isGone ? "expired" : "failed",
          statusCode || null,
          (pushError?.message ?? String(error)).slice(0, 500),
          attemptedAt,
        );

        return isGone ? "expired" : "failed";
      }
    },
  );

  db.query("UPDATE notifications SET sent_count = ?, failed_count = ? WHERE id = ?").run(
    sent,
    failed,
    id,
  );

  audit(db, {
    actor: input.actor,
    action: "notification.sent",
    target: id,
    channelId: input.channel.id,
    outcome: `${sent} sent, ${failed} failed, ${disabled} disabled`,
    ip: input.ip,
  });

  void results;

  return {
    notificationId: id,
    channel: input.channel.slug,
    sent,
    failed,
    disabled,
    skipped: false,
  };
}

export function getNotification(db: DB, id: string): NotificationDetail | null {
  const row = db
    .query(
      `SELECT n.*, c.slug AS channel_slug, c.name AS channel_name
       FROM notifications n
       JOIN channels c ON c.id = n.channel_id
       WHERE n.id = ?`,
    )
    .get(id) as (NotificationRow & { channel_slug: string; channel_name: string }) | null;

  if (!row) return null;

  const deliveries = db
    .query(
      `SELECT d.id, d.notification_id, d.subscription_id, d.status, d.status_code,
              d.error, d.attempted_at, s.device_id, dev.label AS device_label,
              c.slug AS channel_slug
       FROM deliveries d
       JOIN subscriptions s ON s.id = d.subscription_id
       JOIN devices dev ON dev.id = s.device_id
       JOIN channels c ON c.id = s.channel_id
       WHERE d.notification_id = ?
       ORDER BY d.attempted_at ASC`,
    )
    .all(id) as Array<{
    id: string;
    notification_id: string;
    subscription_id: string;
    status: string;
    status_code: number | null;
    error: string | null;
    attempted_at: number;
    device_id: string;
    device_label: string;
    channel_slug: string;
  }>;

  return {
    ...mapNotification(row),
    channelSlug: row.channel_slug,
    channelName: row.channel_name,
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      notificationId: delivery.notification_id,
      subscriptionId: delivery.subscription_id,
      status: delivery.status,
      statusCode: delivery.status_code,
      error: delivery.error,
      attemptedAt: delivery.attempted_at,
      deviceId: delivery.device_id,
      deviceLabel: delivery.device_label,
      channelSlug: delivery.channel_slug,
    })),
  };
}

export function listNotifications(
  db: DB,
  options: { channelId?: string | null; limit?: number } = {},
): NotificationRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const rows = options.channelId
    ? (db
        .query(
          "SELECT * FROM notifications WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(options.channelId, limit) as NotificationRow[])
    : (db
        .query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
        .all(limit) as NotificationRow[]);

  return rows.map(mapNotification);
}

export function pruneOldData(db: DB, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  db.query("DELETE FROM notifications WHERE created_at < ?").run(cutoff);
  db.query("DELETE FROM enrollment_tokens WHERE expires_at < ? AND used_at IS NOT NULL").run(
    cutoff,
  );
  db.query("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
}
