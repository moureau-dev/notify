import {
  McpServer,
  requireScopes,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import QRCode from "qrcode";
import * as z from "zod/v4";
import type { Config } from "../config";
import type { DB } from "../db";
import { audit } from "../core/audit";
import {
  createChannel,
  getChannelBySlug,
  getDefaultChannel,
  getOrCreateChannel,
  listChannels,
  resolveChannel,
} from "../core/channels";
import { disableSubscription, findSubscriptionById, listSubscriptionsForDevice } from "../core/subscriptions";
import { listDevices } from "../core/devices";
import { createEnrollment } from "../core/enrollment";
import { ForbiddenError, NotFoundError, ServiceUnavailableError, isAppError } from "../core/errors";
import { listNotifications, sendNotification } from "../core/notifications";
import type { PushSender } from "../core/push/types";
import { requireGlobal } from "../core/tokens";
import { SCOPES, type AuthContext } from "../core/types";

export interface McpDeps {
  db: DB;
  config: Config;
  pushSender: PushSender | null;
}

function authFromInfo(authInfo?: AuthInfo): AuthContext {
  const extra = authInfo?.extra ?? {};
  const channelId = typeof extra.channelId === "string" ? extra.channelId : null;
  const name = typeof extra.name === "string" ? extra.name : "mcp";

  return {
    tokenId: authInfo?.clientId ?? "unknown",
    name,
    scopes: new Set(authInfo?.scopes ?? []),
    channelId,
    expiresAt: authInfo?.expiresAt ? authInfo.expiresAt * 1000 : null,
  };
}

function text(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toolError(error: unknown) {
  const message = isAppError(error) ? error.message : error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function runTool<T>(fn: () => Promise<T> | T) {
  try {
    return text(await fn());
  } catch (error) {
    return toolError(error);
  }
}

export function buildMcpServer({ db, config, pushSender }: McpDeps, authInfo?: AuthInfo): McpServer {
  const auth = authFromInfo(authInfo);
  const server = new McpServer({
    name: "notify",
    version: "0.1.0",
    description:
      "Send Web Push notifications. Use notify for sends. Admin tools are disabled unless MCP_ADMIN_ENABLED=1. Omit channel to use the default channel.",
  });

  server.registerTool(
    "notify",
    {
      title: "Send a notification",
      description: "Send a Web Push notification to a channel. Omit channel to use the default channel.",
      inputSchema: z.object({
        channel: z.string().min(1).max(63).optional().describe("Channel slug. Defaults to the default channel."),
        title: z.string().min(1).max(200).optional().describe("Notification title."),
        body: z.string().min(1).max(3000).describe("Notification body."),
        url: z.string().url().max(2048).optional().describe("URL to open when the notification is clicked."),
        tag: z.string().max(64).optional().describe("Notification tag for replacing prior notifications."),
        data: z.record(z.string(), z.unknown()).optional().describe("Extra payload data."),
      }),
      scopeChallenge: requireScopes("notify:send"),
    },
    async (args) =>
      runTool(async () => {
        if (!pushSender) throw new ServiceUnavailableError("Web Push is not configured");

        const channel = resolveChannel(db, auth, args.channel);
        return sendNotification(db, pushSender, {
          channel,
          title: args.title ?? "Notification",
          body: args.body,
          url: args.url,
          tag: args.tag,
          data: args.data,
          source: "mcp",
          concurrency: config.pushConcurrency,
          allowInsecureUrl: !config.isProduction,
          actor: auth.tokenId,
        });
      }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description: "List notification channels visible to the current token.",
      inputSchema: z.object({}),
      scopeChallenge: requireScopes("channels:read"),
    },
    async () =>
      runTool(() =>
        listChannels(db, auth).map((channel) => ({
          slug: channel.slug,
          name: channel.name,
          isDefault: channel.isDefault,
        })),
      ),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List devices with their subscription counts. Push endpoints are never returned.",
      inputSchema: z.object({
        channel: z.string().min(1).max(63).optional().describe("Optional channel slug."),
      }),
      scopeChallenge: requireScopes("devices:read"),
    },
    async (args) =>
      runTool(() => {
        let channelId = auth.channelId;

        if (!channelId && args.channel) {
          const channel = getChannelBySlug(db, args.channel);
          if (!channel) throw new NotFoundError("Channel not found");
          channelId = channel.id;
        }

        return listDevices(db, channelId).map((device) => ({
          id: device.id,
          label: device.label,
          subscriptionCount: device.subscriptionCount,
          activeSubscriptionCount: device.activeSubscriptionCount,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          subscriptions: listSubscriptionsForDevice(db, device.id)
            .filter((subscription) => !channelId || subscription.channelId === channelId)
            .map((subscription) => ({
              id: subscription.id,
              channel: subscription.channelSlug,
              disabledAt: subscription.disabledAt,
            })),
        }));
      }),
  );

  server.registerTool(
    "list_notifications",
    {
      title: "List notifications",
      description: "List recent notifications visible to the current token.",
      inputSchema: z.object({
        channel: z.string().min(1).max(63).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      scopeChallenge: requireScopes("notify:read"),
    },
    async (args) =>
      runTool(() => {
        const channel = resolveChannel(db, auth, args.channel);
        return listNotifications(db, { channelId: channel.id, limit: args.limit });
      }),
  );

  if (config.mcpAdminEnabled) {
    server.registerTool(
      "create_channel",
      {
        title: "Create a channel",
        description: "Create a notification channel. Requires a global admin token.",
        inputSchema: z.object({
          name: z.string().min(1).max(80),
          slug: z.string().min(1).max(63).optional(),
          makeDefault: z.boolean().optional(),
        }),
        scopeChallenge: requireScopes("channels:write"),
      },
      async (args) =>
        runTool(() => {
          requireGlobal(auth);
          const channel = createChannel(db, {
            name: args.name,
            slug: args.slug,
            makeDefault: args.makeDefault,
            actor: auth.tokenId,
          });
          return { slug: channel.slug, name: channel.name, isDefault: channel.isDefault };
        }),
    );

    server.registerTool(
      "register_device",
      {
        title: "Create an enrollment link and QR",
        description:
          "Create a one-time enrollment URL and QR code for a device. Requires devices:write. Admin tokens can get-or-create the channel.",
        inputSchema: z.object({
          channel: z.string().min(1).max(63).optional(),
          label: z.string().min(1).max(80).optional(),
          ttlMs: z
            .number()
            .int()
            .min(60_000)
            .max(24 * 60 * 60 * 1000)
            .optional()
            .describe("Enrollment link lifetime in milliseconds. Default 15 minutes, max 24 hours."),
          create: z.boolean().optional().describe("Create the channel if missing (global tokens only)."),
        }),
        scopeChallenge: requireScopes("devices:write"),
      },
      async (args) => {
        try {
          let channel;

          if (auth.channelId) {
            channel = resolveChannel(db, auth, args.channel);
          } else if (args.channel) {
            if (args.create === false) {
              channel = getChannelBySlug(db, args.channel);
              if (!channel) throw new NotFoundError("Channel not found");
            } else {
              channel = getOrCreateChannel(db, { name: args.channel, actor: auth.tokenId }).channel;
            }
          } else {
            channel = getDefaultChannel(db);
          }

          const enrollment = createEnrollment(db, {
            channelId: channel.id,
            label: args.label,
            ttlMs: args.ttlMs,
            publicUrl: config.publicUrl,
            createdBy: auth.tokenId,
            actor: auth.tokenId,
          });

          audit(db, {
            actor: auth.tokenId,
            action: "mcp.register_device",
            target: channel.slug,
            channelId: channel.id,
            outcome: "success",
          });

          const payload = {
            url: enrollment.url,
            token: enrollment.token,
            expiresAt: enrollment.expiresAt,
            channel: { slug: channel.slug, name: channel.name },
          };

          const qrText = await QRCode.toString(enrollment.url, {
            type: "terminal",
            small: true,
          });
          const qrPng = await QRCode.toBuffer(enrollment.url, {
            width: 512,
            margin: 2,
          });

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(payload, null, 2) },
              { type: "text" as const, text: qrText },
              {
                type: "image" as const,
                data: qrPng.toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );

    server.registerTool(
      "manage_subscription",
      {
        title: "Manage a subscription",
        description: "Disable or delete a device subscription by id. Requires devices:write.",
        inputSchema: z.object({
          id: z.string().min(1).max(128),
          action: z.enum(["disable", "delete"]),
        }),
        scopeChallenge: requireScopes("devices:write"),
      },
      async (args) =>
        runTool(() => {
          const subscription = findSubscriptionById(db, args.id);
          if (!subscription) throw new NotFoundError("Subscription not found");
          if (auth.channelId && auth.channelId !== subscription.channelId) {
            throw new ForbiddenError("Token is not allowed to manage this subscription");
          }

          if (args.action === "delete") {
            db.query("DELETE FROM subscriptions WHERE id = ?").run(args.id);
          } else {
            disableSubscription(db, args.id);
          }

          audit(db, {
            actor: auth.tokenId,
            action: `mcp.subscription_${args.action}`,
            target: args.id,
            channelId: subscription.channelId,
            outcome: "success",
          });

          return { id: args.id, action: args.action };
        }),
    );
  }

  return server;
}

export function effectiveScopes(auth: AuthContext): string[] {
  return auth.scopes.has("admin") ? [...SCOPES] : [...auth.scopes];
}
