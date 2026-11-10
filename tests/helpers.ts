import type { Config } from "../src/config";
import { openAndMigrate, type DB } from "../src/db";
import { getOrCreateChannel } from "../src/core/channels";
import { createApiToken } from "../src/core/tokens";
import type { PushSubscriptionInput } from "../src/core/types";
import {
  PushSendError,
  type PushPayload,
  type PushSendResult,
  type PushSender,
} from "../src/core/push/types";

export function makeDb(): DB {
  return openAndMigrate(":memory:");
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "test",
    isProduction: false,
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    publicUrl: "http://localhost:8787",
    publicOrigin: "http://localhost:8787",
    publicHostname: "localhost",
    vapid: {
      publicKey: "test-public",
      privateKey: "test-private",
      subject: "mailto:test@example.com",
    },
    bootstrapToken: null,
    logLevel: "error",
    trustProxy: false,
    mcpAdminEnabled: true,
    pushTimeoutMs: 1000,
    pushConcurrency: 4,
    retentionDays: 90,
    pushHosts: ["fcm.googleapis.com"],
    cookieName: "notify_device",
    cookieSecure: false,
    allowedHosts: ["localhost", "127.0.0.1"],
    ...overrides,
  };
}

export function testChannel(db: DB, name = "test") {
  return getOrCreateChannel(db, { name }).channel;
}

export function testToken(
  db: DB,
  scopes: string[],
  channelId: string | null = null,
) {
  return createApiToken(db, { name: "test-token", scopes, channelId });
}

export const VALID_SUBSCRIPTION: PushSubscriptionInput = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-subscription",
  keys: {
    p256dh: Buffer.alloc(65, 1).toString("base64url"),
    auth: Buffer.alloc(16, 2).toString("base64url"),
  },
};

export class FakePushSender implements PushSender {
  calls: Array<{ subscription: PushSubscriptionInput; payload: PushPayload }> = [];
  behavior: "ok" | "gone" | "fail" | "mixed";

  constructor(behavior: "ok" | "gone" | "fail" | "mixed" = "ok") {
    this.behavior = behavior;
  }

  async send(
    subscription: PushSubscriptionInput,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    this.calls.push({ subscription, payload });

    if (this.behavior === "gone") throw new PushSendError(410, "Gone");
    if (this.behavior === "fail") throw new PushSendError(500, "Push service error");
    if (this.behavior === "mixed" && subscription.endpoint.includes("gone")) {
      throw new PushSendError(410, "Gone");
    }

    return { statusCode: 201 };
  }
}
