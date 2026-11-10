import { describe, expect, test } from "bun:test";
import {
  createChannel,
  deleteChannel,
  getDefaultChannel,
  getOrCreateChannel,
  listChannels,
  slugify,
  setDefaultChannel,
} from "../src/core/channels";
import { createDevice } from "../src/core/devices";
import { upsertSubscription } from "../src/core/subscriptions";
import { makeDb, VALID_SUBSCRIPTION } from "./helpers";

describe("channels", () => {
  test("slugifies names", () => {
    expect(slugify("Alice's Phone")).toBe("alice-s-phone");
    expect(slugify("  Team  Ops  ")).toBe("team-ops");
  });

  test("gets or creates a channel", () => {
    const db = makeDb();

    const first = getOrCreateChannel(db, { name: "alice" });
    expect(first.created).toBe(true);
    expect(first.channel.slug).toBe("alice");

    const second = getOrCreateChannel(db, { name: "Alice" });
    expect(second.created).toBe(false);
    expect(second.channel.id).toBe(first.channel.id);
  });

  test("sets a default channel", () => {
    const db = makeDb();
    const channel = createChannel(db, { name: "alice" });

    setDefaultChannel(db, channel.slug);

    expect(getDefaultChannel(db).slug).toBe("alice");
    expect(listChannels(db)[0]?.slug).toBe("alice");
  });

  test("refuses to delete the default or a channel with subscriptions", () => {
    const db = makeDb();
    const channel = createChannel(db, { name: "alice" });

    const device = createDevice(db, { label: "test" });
    upsertSubscription(db, {
      deviceId: device.id,
      channelId: channel.id,
      endpoint: VALID_SUBSCRIPTION.endpoint,
      p256dh: VALID_SUBSCRIPTION.keys.p256dh,
      auth: VALID_SUBSCRIPTION.keys.auth,
      allowedPushHosts: ["fcm.googleapis.com"],
    });

    expect(() => deleteChannel(db, channel.slug)).toThrow("subscriptions");
    expect(() => deleteChannel(db, "default")).toThrow("default");
  });
});
