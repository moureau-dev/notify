import { describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server/app";
import { createEnrollment } from "../src/core/enrollment";
import { makeDb, FakePushSender, testChannel, testConfig, testToken, VALID_SUBSCRIPTION } from "./helpers";

interface RequestOptions {
  method?: string;
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(app: App, path: string, options: RequestOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("missing Set-Cookie");
  return setCookie.split(";")[0] ?? "";
}

describe("http api", () => {
  test("public health and config", async () => {
    const db = makeDb();
    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });

    const health = await call(app, "/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, db: true });

    const config = await call(app, "/api/config");
    expect(config.status).toBe(200);
    const body = (await config.json()) as { vapidPublicKey: string; defaultChannel: string };
    expect(body.vapidPublicKey).toBe("test-public");
    expect(body.defaultChannel).toBe("default");
  });

  test("enforces authentication and scopes on notify", async () => {
    const db = makeDb();
    const sender = new FakePushSender();
    const app = createApp({ config: testConfig(), db, pushSender: sender });

    const noToken = await call(app, "/api/notify", {
      method: "POST",
      body: { body: "hello" },
    });
    expect(noToken.status).toBe(401);

    const wrongScope = testToken(db, ["channels:read"]);
    const forbidden = await call(app, "/api/notify", {
      method: "POST",
      token: wrongScope.token,
      body: { body: "hello" },
    });
    expect(forbidden.status).toBe(403);

    const sendToken = testToken(db, ["notify:send"]);
    const ok = await call(app, "/api/notify", {
      method: "POST",
      token: sendToken.token,
      body: { body: "hello" },
    });
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as { skipped: boolean };
    expect(result.skipped).toBe(true);
  });

  test("denies cross-channel sends for a channel-scoped token", async () => {
    const db = makeDb();
    const alice = testChannel(db, "alice");
    const bob = testChannel(db, "bob");
    const token = testToken(db, ["notify:send"], alice.id);

    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });

    const denied = await call(app, "/api/notify", {
      method: "POST",
      token: token.token,
      body: { channel: "bob", body: "hello" },
    });

    expect(denied.status).toBe(403);

    const allowed = await call(app, "/api/notify", {
      method: "POST",
      token: token.token,
      body: { channel: "alice", body: "hello" },
    });
    expect(allowed.status).toBe(200);

    void bob;
  });

  test("enrolls a device, sets a cookie, and sends a test notification", async () => {
    const db = makeDb();
    const sender = new FakePushSender();
    const channel = testChannel(db, "alice");
    const app = createApp({ config: testConfig(), db, pushSender: sender });

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      publicUrl: "http://localhost:8787",
    });

    const enroll = await call(app, "/api/enroll", {
      method: "POST",
      body: { token: enrollment.token, subscription: VALID_SUBSCRIPTION, label: "Browser" },
    });

    expect(enroll.status).toBe(201);
    const cookie = cookieFrom(enroll);

    const me = await call(app, "/api/subscriptions/me", { cookie });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { subscriptions: unknown[] };
    expect(meBody.subscriptions).toHaveLength(1);

    const testSend = await call(app, "/api/subscriptions/me/test", {
      method: "POST",
      cookie,
    });
    expect(testSend.status).toBe(200);
    expect(sender.calls).toHaveLength(1);
  });

  test("lists subscriptions with device and channel context", async () => {
    const db = makeDb();
    const sender = new FakePushSender();
    const channel = testChannel(db, "alice");
    const app = createApp({ config: testConfig(), db, pushSender: sender });

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      publicUrl: "http://localhost:8787",
    });

    await call(app, "/api/enroll", {
      method: "POST",
      body: { token: enrollment.token, subscription: VALID_SUBSCRIPTION, label: "Browser" },
    });

    const reader = testToken(db, ["devices:read"]);
    const response = await call(app, "/api/subscriptions", { token: reader.token });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      subscriptions: Array<{
        id: string;
        deviceLabel: string;
        channel: { slug: string };
        disabledAt: number | null;
      }>;
    };

    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0]?.deviceLabel).toBe("Browser");
    expect(body.subscriptions[0]?.channel.slug).toBe("alice");
    expect(body.subscriptions[0]?.disabledAt).toBeNull();
  });

  test("shows a notification with its delivery attempts", async () => {
    const db = makeDb();
    const sender = new FakePushSender();
    const channel = testChannel(db, "alice");
    const app = createApp({ config: testConfig(), db, pushSender: sender });

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      publicUrl: "http://localhost:8787",
    });

    await call(app, "/api/enroll", {
      method: "POST",
      body: { token: enrollment.token, subscription: VALID_SUBSCRIPTION, label: "Browser" },
    });

    const sendToken = testToken(db, ["notify:send"]);
    const sent = await call(app, "/api/notify", {
      method: "POST",
      token: sendToken.token,
      body: { channel: "alice", body: "hello" },
    });
    expect(sent.status).toBe(200);
    const sentBody = (await sent.json()) as { notificationId: string };

    const reader = testToken(db, ["notify:read"]);
    const detail = await call(app, `/api/notifications/${sentBody.notificationId}`, {
      token: reader.token,
    });

    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      notification: {
        id: string;
        channelSlug: string;
        sentCount: number;
        deliveries: Array<{ status: string; deviceLabel: string }>;
      };
    };

    expect(body.notification.id).toBe(sentBody.notificationId);
    expect(body.notification.channelSlug).toBe("alice");
    expect(body.notification.sentCount).toBe(1);
    expect(body.notification.deliveries).toHaveLength(1);
    expect(body.notification.deliveries[0]?.status).toBe("sent");
    expect(body.notification.deliveries[0]?.deviceLabel).toBe("Browser");
  });

  test("serves the agent contract", async () => {
    const db = makeDb();
    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });

    const response = await call(app, "/llms.txt");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("/mcp");
    expect(text).toContain("tools/list");
  });

  test("requires global scope to create channels", async () => {
    const db = makeDb();
    const alice = testChannel(db, "alice");
    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });

    const scoped = testToken(db, ["channels:write"], alice.id);
    const denied = await call(app, "/api/channels", {
      method: "POST",
      token: scoped.token,
      body: { name: "bob" },
    });
    expect(denied.status).toBe(403);

    const global = testToken(db, ["channels:write"]);
    const created = await call(app, "/api/channels", {
      method: "POST",
      token: global.token,
      body: { name: "bob" },
    });
    expect(created.status).toBe(201);
  });

  test("token management requires admin", async () => {
    const db = makeDb();
    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });

    const sendOnly = testToken(db, ["notify:send"]);
    const denied = await call(app, "/api/tokens", { token: sendOnly.token });
    expect(denied.status).toBe(403);

    const admin = testToken(db, ["admin"]);
    const listed = await call(app, "/api/tokens", { token: admin.token });
    expect(listed.status).toBe(200);

    const created = await call(app, "/api/tokens", {
      method: "POST",
      token: admin.token,
      body: { name: "agent", scopes: ["notify:send"] },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { token: { token: string; scopes: string[] } };
    expect(createdBody.token.token.startsWith("ntk_")).toBe(true);
    expect(createdBody.token.scopes).toEqual(["notify:send"]);
  });

  test("get-or-create on enrollment", async () => {
    const db = makeDb();
    const app = createApp({ config: testConfig(), db, pushSender: new FakePushSender() });
    const admin = testToken(db, ["admin"]);

    const created = await call(app, "/api/enrollments", {
      method: "POST",
      token: admin.token,
      body: { channel: "carol", create: true },
    });

    expect(created.status).toBe(201);
    const body = (await created.json()) as { channel: { slug: string }; url: string };
    expect(body.channel.slug).toBe("carol");
    expect(body.url).toContain("/enroll?token=");
  });
});
