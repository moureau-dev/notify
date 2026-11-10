import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import * as z from "zod/v4";
import type { Config } from "../config";
import type { DB } from "../db";
import { audit } from "../core/audit";
import {
  createChannel,
  deleteChannel,
  getChannelById,
  getChannelBySlug,
  getDefaultChannel,
  getOrCreateChannel,
  listChannels,
  resolveChannel,
  setDefaultChannel,
} from "../core/channels";
import { createDevice, listDevices, rotateDeviceSession, updateDevice } from "../core/devices";
import { createEnrollment, consumeEnrollment } from "../core/enrollment";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "../core/errors";
import { getNotification, listNotifications, sendNotification } from "../core/notifications";
import { assertValidPushSubscription } from "../core/push/validate";
import type { PushSender } from "../core/push/types";
import {
  deleteSubscription,
  listSubscriptions,
  listSubscriptionsForDevice,
  upsertSubscription,
} from "../core/subscriptions";
import {
  createApiToken,
  listApiTokens,
  requireGlobal,
  revokeApiToken,
} from "../core/tokens";
import { SCOPES, type AuthContext } from "../core/types";
import { buildMcpServer } from "../mcp";
import {
  authenticate,
  deviceCookieHeader,
  extractBearer,
  getDeviceFromRequest,
} from "./auth";
import {
  applySecurityHeaders,
  errorResponse,
  getClientIp,
  json,
  methodNotAllowed,
  notFound,
  readJson,
  type RequestServer,
} from "./http";
import { RateLimiter } from "./rate-limit";
import { createStaticServer } from "./static";
import { verifyApiToken } from "../core/tokens";

export interface AppDeps {
  config: Config;
  db: DB;
  pushSender: PushSender | null;
}

export interface App {
  fetch(request: Request, server?: RequestServer): Promise<Response>;
}

const enrollSchema = z.object({
  token: z.string().min(1).max(512),
  subscription: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(256),
      auth: z.string().min(1).max(256),
    }),
  }),
  label: z.string().trim().min(1).max(80).optional(),
  userAgent: z.string().max(512).optional(),
});

const notifySchema = z.object({
  channel: z.string().min(1).max(63).optional(),
  title: z.string().trim().min(1).max(200).default("Notification"),
  body: z.string().trim().min(1).max(3000),
  url: z.string().url().max(2048).optional(),
  tag: z.string().max(64).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().min(1).max(63).optional(),
  makeDefault: z.boolean().optional(),
});

const createEnrollmentSchema = z.object({
  channel: z.string().min(1).max(63).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  ttlMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  create: z.boolean().optional(),
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1),
  channel: z.string().min(1).max(63).optional(),
  expiresAt: z.number().int().positive().optional(),
});

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ValidationError("Invalid limit");
  return parsed;
}

function agentContract(config: Config): string {
  const base = config.publicUrl;
  const lines = [
    "# notify",
    "",
    "Self-hosted Web Push notifications. This is the agent-facing contract.",
    "",
    "## MCP",
    "",
    `Endpoint: POST ${base}/mcp`,
    "Transport: Streamable HTTP (stateless)",
    "Auth: Authorization: Bearer ntk_...",
    "Discovery: call tools/list for the live tool list and JSON Schemas.",
    `MCP admin tools: ${config.mcpAdminEnabled ? "enabled" : "disabled"}`,
    "",
    "Tools:",
    "- notify: send a notification. Arguments: channel?, title?, body, url?, tag?, data?.",
    "- list_channels: list visible channels.",
    "- list_devices: list devices with subscription IDs; push endpoints are never returned.",
    "- list_notifications: list recent notifications.",
  ];
  if (config.mcpAdminEnabled) {
    lines.push(
      "- create_channel: create a channel. Requires channels:write and a global token.",
      "- register_device: create a one-time enrollment URL. Requires devices:write; ttlMs optional.",
      "- manage_subscription: delete or disable a subscription. Requires devices:write.",
    );
  }
  lines.push(
    "",
    "## CLI",
    "",
    "notify setup --json",
    "notify send \"message\" --channel <slug> --json",
    "notify register --channel <slug> --ttl 24h --json",
    "notify notifications list --json",
    "notify notifications show <id> --json",
    "notify subscription list --json",
    "",
    "## Notes",
    "",
    "- Use a send-only token (notify:send) for agents unless administration is required.",
    "- Omit channel to use the default channel.",
    "- Notifications and delivery attempts are stored in SQLite.",
    "",
  );
  return lines.join("\n");
}

function unauthorizedMcp(): Response {
  return json(
    { error: { code: "unauthorized", message: "Authentication required" } },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="notify"',
      },
    },
  );
}

export function createApp(deps: AppDeps): App {
  const { config, db, pushSender } = deps;
  const limiter = new RateLimiter();
  const publicDir = process.env.PUBLIC_DIR ?? resolve("public");
  const serveStatic = createStaticServer(publicDir);

  const mcpHandler = createMcpHandler(
    (ctx) => buildMcpServer({ db, config, pushSender }, ctx.authInfo),
    {
      legacy: "stateless",
      maxRequestBodySize: 64 * 1024,
      onerror: (error) => {
        console.error("[notify] mcp error", error.message);
      },
    },
  );

  async function handleMcp(
    request: Request,
    server: RequestServer | undefined,
  ): Promise<Response> {
    const ip = getClientIp(request, config, server);
    const token = extractBearer(request);

    if (!token) {
      limiter.check(`mcp-auth:${ip}`, 30, 60_000);
      return unauthorizedMcp();
    }

    const auth = verifyApiToken(db, token);
    if (!auth) {
      limiter.check(`mcp-auth:${ip}`, 30, 60_000);
      return unauthorizedMcp();
    }

    limiter.check(`mcp:${auth.tokenId}`, 120, 60_000);
    limiter.check(`mcp-ip:${ip}`, 240, 60_000);

    const rejected =
      hostHeaderValidationResponse(request, config.allowedHosts) ??
      originValidationResponse(request, config.allowedHosts);

    if (rejected) return rejected;

    const scopes = auth.scopes.has("admin") ? [...SCOPES] : [...auth.scopes];
    const authInfo: AuthInfo = {
      token,
      clientId: auth.tokenId,
      scopes,
      expiresAt: Math.floor((auth.expiresAt ?? Date.now() + 60 * 60 * 1000) / 1000),
      extra: {
        channelId: auth.channelId,
        name: auth.name,
      },
    };

    return mcpHandler.fetch(request, { authInfo });
  }

  async function handleEnroll(
    request: Request,
    server: RequestServer | undefined,
  ): Promise<Response> {
    const ip = getClientIp(request, config, server);
    limiter.check(`enroll:${ip}`, 20, 60_000);

    const body = await readJson(request, enrollSchema, 16 * 1024);

    assertValidPushSubscription(body.subscription, config.pushHosts);

    const enrollment = consumeEnrollment(db, body.token, { ip });

    const existing = getDeviceFromRequest(db, request, config);
    const userAgent = request.headers.get("user-agent") ?? body.userAgent ?? null;

    const device = existing
      ? updateDevice(db, existing.id, { label: body.label ?? enrollment.label, userAgent })
      : createDevice(db, { label: body.label ?? enrollment.label, userAgent });

    const upserted = upsertSubscription(db, {
      deviceId: device.id,
      channelId: enrollment.channelId,
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
      allowedPushHosts: config.pushHosts,
      actor: device.id,
      ip,
    });

    const channel = getChannelById(db, enrollment.channelId);
    if (!channel) throw new NotFoundError("Channel not found");

    const deviceToken = rotateDeviceSession(db, device.id);

    return json(
      {
        channel: { slug: channel.slug, name: channel.name },
        device: { id: device.id, label: device.label },
        subscriptionId: upserted.subscription.id,
      },
      {
        status: 201,
        headers: {
          "Set-Cookie": deviceCookieHeader(config, deviceToken),
        },
      },
    );
  }

  async function handleApi(
    request: Request,
    url: URL,
    method: string,
    server: RequestServer | undefined,
  ): Promise<Response> {
    const ip = getClientIp(request, config, server);
    const path = url.pathname;

    if (path === "/api/subscriptions/me") {
      if (method !== "GET") return methodNotAllowed("GET");
      const device = getDeviceFromRequest(db, request, config);
      if (!device) throw new UnauthorizedError("Device session required");

      return json({
        device: { id: device.id, label: device.label },
        subscriptions: listSubscriptionsForDevice(db, device.id).map((subscription) => ({
          id: subscription.id,
          channel: {
            slug: subscription.channelSlug,
            name: subscription.channelName,
            isDefault: subscription.channelIsDefault,
          },
          createdAt: subscription.createdAt,
          disabledAt: subscription.disabledAt,
        })),
      });
    }

    if (path === "/api/subscriptions/me/test") {
      if (method !== "POST") return methodNotAllowed("POST");
      const device = getDeviceFromRequest(db, request, config);
      if (!device) throw new UnauthorizedError("Device session required");
      if (!pushSender) throw new ServiceUnavailableError("Web Push is not configured");

      limiter.check(`device-test:${device.id}`, 10, 60_000);

      const subscriptions = listSubscriptionsForDevice(db, device.id).filter(
        (subscription) => subscription.disabledAt === null,
      );
      if (subscriptions.length === 0) throw new NotFoundError("No active subscriptions");

      const byChannel = new Map<string, string[]>();
      for (const subscription of subscriptions) {
        const list = byChannel.get(subscription.channelId) ?? [];
        list.push(subscription.id);
        byChannel.set(subscription.channelId, list);
      }

      const results = [];
      for (const [channelId, subscriptionIds] of byChannel) {
        const channel = getChannelById(db, channelId);
        if (!channel) continue;

        results.push(
          await sendNotification(db, pushSender, {
            channel,
            title: "Test notification",
            body: "Notifications are working.",
            source: "device-test",
            subscriptionIds,
            concurrency: config.pushConcurrency,
            allowInsecureUrl: !config.isProduction,
            actor: device.id,
            ip,
          }),
        );
      }

      return json({ results });
    }

    if (path.startsWith("/api/subscriptions/me/")) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      const device = getDeviceFromRequest(db, request, config);
      if (!device) throw new UnauthorizedError("Device session required");

      const id = decodeURIComponent(path.slice("/api/subscriptions/me/".length));
      const subscription = deleteSubscription(db, id, { deviceId: device.id, actor: device.id, ip });
      return json({ deleted: subscription.id });
    }

    const auth = authenticate(db, request);

    if (path === "/api/subscriptions") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!auth.scopes.has("admin") && !auth.scopes.has("devices:read")) {
        throw new ForbiddenError("Missing scope: devices:read");
      }

      const requested = url.searchParams.get("channel");
      let channelId: string | null = auth.channelId;

      if (!channelId && requested) {
        const channel = getChannelBySlug(db, requested);
        if (!channel) throw new NotFoundError("Channel not found");
        channelId = channel.id;
      }

      return json({
        subscriptions: listSubscriptions(db, { channelId }).map((subscription) => ({
          id: subscription.id,
          deviceId: subscription.deviceId,
          deviceLabel: subscription.deviceLabel,
          channel: {
            slug: subscription.channelSlug,
            name: subscription.channelName,
            isDefault: subscription.channelIsDefault,
          },
          disabledAt: subscription.disabledAt,
          createdAt: subscription.createdAt,
        })),
      });
    }

    if (path === "/api/notify") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!auth.scopes.has("admin") && !auth.scopes.has("notify:send")) {
        throw new ForbiddenError("Missing scope: notify:send");
      }
      if (!pushSender) throw new ServiceUnavailableError("Web Push is not configured");

      limiter.check(`notify:${auth.tokenId}`, 60, 60_000);

      const body = await readJson(request, notifySchema, 8 * 1024);
      const channel = resolveChannel(db, auth, body.channel);

      const result = await sendNotification(db, pushSender, {
        channel,
        title: body.title,
        body: body.body,
        url: body.url,
        tag: body.tag,
        data: body.data,
        source: "api",
        concurrency: config.pushConcurrency,
        allowInsecureUrl: !config.isProduction,
        actor: auth.tokenId,
        ip,
      });

      return json(result);
    }

    if (path === "/api/notifications") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!auth.scopes.has("admin") && !auth.scopes.has("notify:read")) {
        throw new ForbiddenError("Missing scope: notify:read");
      }

      const requested = url.searchParams.get("channel");
      let channelId: string | null = auth.channelId;

      if (!channelId && requested) {
        const channel = getChannelBySlug(db, requested);
        if (!channel) throw new NotFoundError("Channel not found");
        channelId = channel.id;
      }

      return json({
        notifications: listNotifications(db, {
          channelId,
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      });
    }

    if (path.startsWith("/api/notifications/")) {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!auth.scopes.has("admin") && !auth.scopes.has("notify:read")) {
        throw new ForbiddenError("Missing scope: notify:read");
      }

      const id = decodeURIComponent(path.slice("/api/notifications/".length));
      const notification = getNotification(db, id);
      if (!notification) throw new NotFoundError("Notification not found");
      if (auth.channelId && auth.channelId !== notification.channelId) {
        throw new ForbiddenError("Token is not allowed to read this notification");
      }

      return json({ notification });
    }

    if (path === "/api/channels") {
      if (method === "GET") {
        if (!auth.scopes.has("admin") && !auth.scopes.has("channels:read")) {
          throw new ForbiddenError("Missing scope: channels:read");
        }
        return json({ channels: listChannels(db, auth) });
      }

      if (method === "POST") {
        if (!auth.scopes.has("admin") && !auth.scopes.has("channels:write")) {
          throw new ForbiddenError("Missing scope: channels:write");
        }
        requireGlobal(auth);
        const body = await readJson(request, createChannelSchema);
        const channel = createChannel(db, { ...body, actor: auth.tokenId, ip });
        return json({ channel }, { status: 201 });
      }

      return methodNotAllowed("GET, POST");
    }

    if (path.startsWith("/api/channels/") && path.endsWith("/default")) {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!auth.scopes.has("admin") && !auth.scopes.has("channels:write")) {
        throw new ForbiddenError("Missing scope: channels:write");
      }
      requireGlobal(auth);

      const slug = decodeURIComponent(
        path.slice("/api/channels/".length, path.length - "/default".length),
      );
      const channel = setDefaultChannel(db, slug, auth.tokenId, ip);
      return json({ channel });
    }

    if (path.startsWith("/api/channels/")) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      if (!auth.scopes.has("admin") && !auth.scopes.has("channels:write")) {
        throw new ForbiddenError("Missing scope: channels:write");
      }
      requireGlobal(auth);

      const slug = decodeURIComponent(path.slice("/api/channels/".length));
      deleteChannel(db, slug, auth.tokenId, ip);
      return json({ deleted: slug });
    }

    if (path === "/api/enrollments") {
      if (method !== "POST") return methodNotAllowed("POST");
      if (!auth.scopes.has("admin") && !auth.scopes.has("devices:write")) {
        throw new ForbiddenError("Missing scope: devices:write");
      }

      limiter.check(`enroll-create:${auth.tokenId}`, 30, 60_000);

      const body = await readJson(request, createEnrollmentSchema);
      let channel;

      if (auth.channelId) {
        channel = resolveChannel(db, auth, body.channel);
      } else if (body.channel) {
        if (body.create === false) {
          channel = getChannelBySlug(db, body.channel);
          if (!channel) throw new NotFoundError("Channel not found");
        } else {
          channel = getOrCreateChannel(db, {
            name: body.channel,
            actor: auth.tokenId,
            ip,
          }).channel;
        }
      } else {
        channel = getDefaultChannel(db);
      }

      const enrollment = createEnrollment(db, {
        channelId: channel.id,
        label: body.label,
        ttlMs: body.ttlMs,
        publicUrl: config.publicUrl,
        createdBy: auth.tokenId,
        actor: auth.tokenId,
        ip,
      });

      return json(
        {
          url: enrollment.url,
          token: enrollment.token,
          expiresAt: enrollment.expiresAt,
          channel: { slug: channel.slug, name: channel.name },
        },
        { status: 201 },
      );
    }

    if (path === "/api/devices") {
      if (method !== "GET") return methodNotAllowed("GET");
      if (!auth.scopes.has("admin") && !auth.scopes.has("devices:read")) {
        throw new ForbiddenError("Missing scope: devices:read");
      }

      const requested = url.searchParams.get("channel");
      let channelId: string | null = auth.channelId;

      if (!channelId && requested) {
        const channel = getChannelBySlug(db, requested);
        if (!channel) throw new NotFoundError("Channel not found");
        channelId = channel.id;
      }

      return json({ devices: listDevices(db, channelId) });
    }

    if (path.startsWith("/api/subscriptions/")) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      if (!auth.scopes.has("admin") && !auth.scopes.has("devices:write")) {
        throw new ForbiddenError("Missing scope: devices:write");
      }

      const id = decodeURIComponent(path.slice("/api/subscriptions/".length));
      const subscription = deleteSubscription(db, id, { auth, actor: auth.tokenId, ip });
      return json({ deleted: subscription.id });
    }

    if (path === "/api/tokens") {
      if (!auth.scopes.has("admin")) throw new ForbiddenError("Missing scope: admin");

      if (method === "GET") {
        return json({ tokens: listApiTokens(db) });
      }

      if (method === "POST") {
        limiter.check(`token-create:${auth.tokenId}`, 20, 60_000);
        const body = await readJson(request, createTokenSchema);

        let channelId: string | null = null;
        if (body.channel) {
          const channel = getChannelBySlug(db, body.channel);
          if (!channel) throw new NotFoundError("Channel not found");
          channelId = channel.id;
        }

        const token = createApiToken(db, {
          name: body.name,
          scopes: body.scopes,
          channelId,
          expiresAt: body.expiresAt,
          actor: auth.tokenId,
          ip,
        });

        return json({ token }, { status: 201 });
      }

      return methodNotAllowed("GET, POST");
    }

    if (path.startsWith("/api/tokens/")) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      if (!auth.scopes.has("admin")) throw new ForbiddenError("Missing scope: admin");

      const id = decodeURIComponent(path.slice("/api/tokens/".length));
      revokeApiToken(db, id, auth.tokenId, ip);
      return json({ revoked: id });
    }

    return notFound();
  }

  async function route(
    request: Request,
    server: RequestServer | undefined,
    requestId: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return methodNotAllowed("GET, POST, DELETE");
    }

    if (path === "/llms.txt") {
      if (method !== "GET") return methodNotAllowed("GET");
      return new Response(agentContract(config), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/healthz") {
      if (method !== "GET") return methodNotAllowed("GET");
      db.query("SELECT 1").get();
      return json({ ok: true, db: true });
    }

    if (path === "/api/config") {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({
        vapidPublicKey: config.vapid?.publicKey ?? null,
        publicUrl: config.publicUrl,
        mcpAdminEnabled: config.mcpAdminEnabled,
        defaultChannel: getDefaultChannel(db).slug,
      });
    }

    if (path === "/mcp") {
      return handleMcp(request, server);
    }

    if (path === "/api/enroll") {
      if (method !== "POST") return methodNotAllowed("POST");
      return handleEnroll(request, server);
    }

    if (path === "/api/subscriptions/me" || path.startsWith("/api/subscriptions/")) {
      return handleApi(request, url, method, server);
    }

    if (path.startsWith("/api/")) {
      return handleApi(request, url, method, server);
    }

    if (method === "GET" || method === "HEAD") {
      const staticResponse = serveStatic(path);
      if (staticResponse) {
        if (method === "HEAD") {
          return new Response(null, { status: staticResponse.status, headers: staticResponse.headers });
        }
        return staticResponse;
      }
    }

    return notFound();
  }

  return {
    async fetch(request: Request, server?: RequestServer): Promise<Response> {
      const requestId = crypto.randomUUID();
      const started = performance.now();
      const url = new URL(request.url);

      try {
        const response = await route(request, server, requestId);
        return applySecurityHeaders(response, config, requestId);
      } catch (error) {
        return applySecurityHeaders(errorResponse(error, requestId), config, requestId);
      } finally {
        if (config.logLevel === "debug" || config.logLevel === "info") {
          console.log(
            JSON.stringify({
              level: "info",
              msg: "request",
              requestId,
              method: request.method,
              path: url.pathname,
              durationMs: Math.round(performance.now() - started),
            }),
          );
        }
      }
    },
  };
}
