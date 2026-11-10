import type { DB } from "../db";
import { audit } from "./audit";
import { randomToken } from "./crypto";
import { ForbiddenError, NotFoundError } from "./errors";
import { assertValidPushSubscription } from "./push/validate";
import type { AuthContext, Subscription } from "./types";

interface SubscriptionRow {
  id: string;
  device_id: string;
  channel_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  disabled_at: number | null;
  failure_count: number;
}

export interface SubscriptionWithChannel extends Subscription {
  channelSlug: string;
  channelName: string;
  channelIsDefault: boolean;
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    deviceId: row.device_id,
    channelId: row.channel_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    failureCount: row.failure_count,
  };
}

export function findSubscriptionById(db: DB, id: string): Subscription | null {
  const row = db.query("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubscriptionRow | null;
  return row ? mapSubscription(row) : null;
}

export function upsertSubscription(
  db: DB,
  input: {
    deviceId: string;
    channelId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    allowedPushHosts: readonly string[];
    actor?: string | null;
    ip?: string | null;
  },
): { subscription: Subscription; created: boolean } {
  assertValidPushSubscription(
    { endpoint: input.endpoint, keys: { p256dh: input.p256dh, auth: input.auth } },
    input.allowedPushHosts,
  );

  const now = Date.now();

  const transaction = db.transaction(() => {
    const existing = db
      .query("SELECT * FROM subscriptions WHERE channel_id = ? AND endpoint = ?")
      .get(input.channelId, input.endpoint) as SubscriptionRow | null;

    if (existing) {
      db.query(
        `UPDATE subscriptions
         SET device_id = ?, p256dh = ?, auth = ?, disabled_at = NULL, failure_count = 0
         WHERE id = ?`,
      ).run(input.deviceId, input.p256dh, input.auth, existing.id);

      db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, input.deviceId);

      return {
        subscription: {
          ...mapSubscription(existing),
          deviceId: input.deviceId,
          p256dh: input.p256dh,
          auth: input.auth,
          disabledAt: null,
          failureCount: 0,
        },
        created: false,
      };
    }

    const id = `sub_${randomToken(10)}`;
    db.query(
      `INSERT INTO subscriptions (id, device_id, channel_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.deviceId, input.channelId, input.endpoint, input.p256dh, input.auth, now);

    db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, input.deviceId);

    return {
      subscription: {
        id,
        deviceId: input.deviceId,
        channelId: input.channelId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        createdAt: now,
        disabledAt: null,
        failureCount: 0,
      },
      created: true,
    };
  });

  const result = transaction();

  audit(db, {
    actor: input.actor,
    action: result.created ? "subscription.created" : "subscription.updated",
    target: result.subscription.id,
    channelId: input.channelId,
    outcome: "success",
    ip: input.ip,
  });

  return result;
}

export function listSubscriptionsForDevice(db: DB, deviceId: string): SubscriptionWithChannel[] {
  const rows = db
    .query(
      `SELECT s.*, c.slug AS channel_slug, c.name AS channel_name, c.is_default AS channel_is_default
       FROM subscriptions s
       JOIN channels c ON c.id = s.channel_id
       WHERE s.device_id = ?
       ORDER BY s.created_at DESC`,
    )
    .all(deviceId) as Array<
    SubscriptionRow & {
      channel_slug: string;
      channel_name: string;
      channel_is_default: number;
    }
  >;

  return rows.map((row) => ({
    ...mapSubscription(row),
    channelSlug: row.channel_slug,
    channelName: row.channel_name,
    channelIsDefault: row.channel_is_default === 1,
  }));
}

export interface SubscriptionWithContext extends SubscriptionWithChannel {
  deviceLabel: string;
}

export function listSubscriptions(
  db: DB,
  options: { channelId?: string | null } = {},
): SubscriptionWithContext[] {
  const rows = (options.channelId
    ? db
        .query(
          `SELECT s.*, d.label AS device_label, c.slug AS channel_slug, c.name AS channel_name, c.is_default AS channel_is_default
           FROM subscriptions s
           JOIN devices d ON d.id = s.device_id
           JOIN channels c ON c.id = s.channel_id
           WHERE s.channel_id = ?
           ORDER BY s.created_at DESC`,
        )
        .all(options.channelId)
    : db
        .query(
          `SELECT s.*, d.label AS device_label, c.slug AS channel_slug, c.name AS channel_name, c.is_default AS channel_is_default
           FROM subscriptions s
           JOIN devices d ON d.id = s.device_id
           JOIN channels c ON c.id = s.channel_id
           ORDER BY s.created_at DESC`,
        )
        .all()) as Array<
    SubscriptionRow & {
      device_label: string;
      channel_slug: string;
      channel_name: string;
      channel_is_default: number;
    }
  >;

  return rows.map((row) => ({
    ...mapSubscription(row),
    deviceLabel: row.device_label,
    channelSlug: row.channel_slug,
    channelName: row.channel_name,
    channelIsDefault: row.channel_is_default === 1,
  }));
}

export function listActiveSubscriptions(
  db: DB,
  channelId: string,
  subscriptionIds?: readonly string[],
): Subscription[] {
  if (subscriptionIds && subscriptionIds.length === 0) return [];

  if (subscriptionIds) {
    const placeholders = subscriptionIds.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT * FROM subscriptions
         WHERE channel_id = ? AND disabled_at IS NULL AND id IN (${placeholders})`,
      )
      .all(channelId, ...subscriptionIds) as SubscriptionRow[];
    return rows.map(mapSubscription);
  }

  const rows = db
    .query("SELECT * FROM subscriptions WHERE channel_id = ? AND disabled_at IS NULL")
    .all(channelId) as SubscriptionRow[];
  return rows.map(mapSubscription);
}

export function disableSubscription(db: DB, id: string): void {
  db.query("UPDATE subscriptions SET disabled_at = ? WHERE id = ?").run(Date.now(), id);
}

export function markSubscriptionFailure(db: DB, id: string): void {
  db.query("UPDATE subscriptions SET failure_count = failure_count + 1 WHERE id = ?").run(id);
}

export function deleteSubscription(
  db: DB,
  id: string,
  options: {
    deviceId?: string;
    auth?: AuthContext;
    actor?: string | null;
    ip?: string | null;
  } = {},
): Subscription {
  const subscription = findSubscriptionById(db, id);
  if (!subscription) throw new NotFoundError("Subscription not found");

  if (options.deviceId && subscription.deviceId !== options.deviceId) {
    throw new ForbiddenError("Subscription does not belong to this device");
  }

  if (options.auth?.channelId && options.auth.channelId !== subscription.channelId) {
    throw new ForbiddenError("Token is not allowed to manage this subscription");
  }

  db.query("DELETE FROM subscriptions WHERE id = ?").run(id);

  audit(db, {
    actor: options.actor,
    action: "subscription.deleted",
    target: id,
    channelId: subscription.channelId,
    outcome: "success",
    ip: options.ip,
  });

  return subscription;
}
