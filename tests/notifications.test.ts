import { describe, expect, test } from "bun:test";
import { createDevice } from "../src/core/devices";
import { sendNotification } from "../src/core/notifications";
import { upsertSubscription } from "../src/core/subscriptions";
import { makeDb, FakePushSender, testChannel, VALID_SUBSCRIPTION } from "./helpers";

function addSubscription(db: ReturnType<typeof makeDb>, channelId: string, endpoint: string) {
  const device = createDevice(db, { label: "test-device" });
  return upsertSubscription(db, {
    deviceId: device.id,
    channelId,
    endpoint,
    p256dh: VALID_SUBSCRIPTION.keys.p256dh,
    auth: VALID_SUBSCRIPTION.keys.auth,
    allowedPushHosts: ["fcm.googleapis.com"],
  }).subscription;
}

describe("notifications", () => {
  test("fans out to active subscriptions and records deliveries", async () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");
    addSubscription(db, channel.id, "https://fcm.googleapis.com/fcm/send/one");

    const sender = new FakePushSender("ok");
    const result = await sendNotification(db, sender, {
      channel,
      title: "Build",
      body: "Done",
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(sender.calls).toHaveLength(1);

    const deliveries = db.query("SELECT status FROM deliveries").all() as Array<{ status: string }>;
    expect(deliveries).toEqual([{ status: "sent" }]);
  });

  test("disables subscriptions on 410", async () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");
    const subscription = addSubscription(db, channel.id, "https://fcm.googleapis.com/fcm/send/gone");

    const sender = new FakePushSender("gone");
    const result = await sendNotification(db, sender, {
      channel,
      title: "Build",
      body: "Done",
    });

    expect(result.disabled).toBe(1);
    expect(result.sent).toBe(0);

    const row = db
      .query("SELECT disabled_at FROM subscriptions WHERE id = ?")
      .get(subscription.id) as { disabled_at: number | null };
    expect(row.disabled_at).not.toBeNull();
  });

  test("increments failure count on transient errors", async () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");
    const subscription = addSubscription(db, channel.id, "https://fcm.googleapis.com/fcm/send/fail");

    const sender = new FakePushSender("fail");
    const result = await sendNotification(db, sender, {
      channel,
      title: "Build",
      body: "Done",
    });

    expect(result.failed).toBe(1);

    const row = db
      .query("SELECT failure_count FROM subscriptions WHERE id = ?")
      .get(subscription.id) as { failure_count: number };
    expect(row.failure_count).toBe(1);
  });

  test("skips when the channel has no subscriptions", async () => {
    const db = makeDb();
    const channel = testChannel(db, "empty");
    const sender = new FakePushSender("ok");

    const result = await sendNotification(db, sender, {
      channel,
      title: "Build",
      body: "Done",
    });

    expect(result.skipped).toBe(true);
    expect(sender.calls).toHaveLength(0);
  });
});
