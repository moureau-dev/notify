import { parseArgs } from "node:util";
import QRCode from "qrcode";
import * as webpush from "web-push";
import { CliError, NotifyClient, loadCliConfig, saveCliConfig } from "./client";
import { parseTtl } from "./duration";

const USAGE = `notify — self-hosted Web Push

Usage:
  notify serve [--dev] [--tailscale] [--tailscale-port 8443] [--tailscale-force] [--tailscale-keep]
  notify vapid generate [--json]
  notify login --url <url> --token <token>
  notify send <message> [--title <title>] [--channel <slug>] [--link <url>] [--tag <tag>] [--json]
  notify register [--channel <slug>] [--label <label>] [--ttl 15m] [--no-create] [--json]
  notify channel list [--json]
  notify channel create <name> [--default] [--json]
  notify channel delete <slug> [--json]
  notify channel set-default <slug> [--json]
  notify device list [--channel <slug>] [--json]
  notify subscription list [--channel <slug>] [--json]
  notify subscription remove <subscription-id> [--json]
  notify notifications list [--channel <slug>] [--limit <n>] [--json]
  notify notifications show <id> [--json]
  notify setup [--json]
  notify token create --name <name> --scope <scope> [--scope <scope>...] [--channel <slug>] [--expires-at <iso>] [--json]
  notify token list [--json]
  notify token revoke <token-id> [--json]
  notify doctor

Global:
  --url <url>       Server URL (default: NOTIFY_URL or http://127.0.0.1:8787)
  --token <token>   API token (default: NOTIFY_TOKEN or ~/.config/notify/config.json)
  --json            Machine-readable output
`;

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function multiValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

function print(data: unknown, asJson: boolean, human?: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (human) human();
  else console.log(JSON.stringify(data, null, 2));
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

export async function runCLI(command: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean" },
      channel: { type: "string" },
      label: { type: "string" },
      title: { type: "string" },
      tag: { type: "string" },
      link: { type: "string" },
      name: { type: "string" },
      scope: { type: "string", multiple: true },
      "expires-at": { type: "string" },
      ttl: { type: "string" },
      "no-create": { type: "boolean" },
      default: { type: "boolean" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const asJson = boolValue(values.json);

  if (command === "help" || command === "--help" || command === "-h" || boolValue(values.help)) {
    console.log(USAGE);
    return;
  }

  if (command === "vapid") {
    if (positionals[0] !== "generate") {
      throw new CliError("Usage: notify vapid generate");
    }

    const keys = webpush.generateVAPIDKeys();
    print(
      {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        subject: "mailto:you@example.com",
      },
      asJson,
      () => {
        console.log("Store these as server secrets. Do not commit them.");
        console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
        console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
        console.log("VAPID_SUBJECT=mailto:you@example.com");
      },
    );
    return;
  }

  const stored = loadCliConfig();
  const baseUrl = stringValue(values.url) ?? stored.url;
  const token = stringValue(values.token) ?? stored.token;

  if (command === "login") {
    if (!baseUrl || !token) throw new CliError("Usage: notify login --url <url> --token <token>");
    saveCliConfig({ url: baseUrl, token });
    print({ ok: true, config: "saved" }, asJson, () => console.log(`Saved credentials for ${baseUrl}`));
    return;
  }

  const client = new NotifyClient(baseUrl, token);

  if (command === "send") {
    const body = positionals.join(" ").trim();
    if (!body) throw new CliError("Usage: notify send <message>");

    const result = await client.request<{
      notificationId: string;
      channel: string;
      sent: number;
      failed: number;
      disabled: number;
      skipped: boolean;
    }>("POST", "/api/notify", {
      title: stringValue(values.title) ?? "Notification",
      body,
      channel: stringValue(values.channel),
      url: stringValue(values.link),
      tag: stringValue(values.tag),
    });

    print(result, asJson, () => {
      console.log(
        `Sent to ${result.channel}: ${result.sent} delivered, ${result.failed} failed, ${result.disabled} expired.`,
      );
    });
    return;
  }

  if (command === "register") {
    const ttlValue = stringValue(values.ttl);
    const ttlMs = ttlValue ? parseTtl(ttlValue) : undefined;

    const result = await client.request<{
      url: string;
      expiresAt: number;
      channel: { slug: string; name: string };
    }>("POST", "/api/enrollments", {
      channel: stringValue(values.channel),
      label: stringValue(values.label),
      ttlMs,
      create: boolValue(values["no-create"]) ? false : undefined,
    });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Enrollment for ${result.channel.name} (${result.channel.slug})`);
    console.log(result.url);
    console.log(`Expires ${formatDate(result.expiresAt)}`);

    try {
      const qr = await QRCode.toString(result.url, { type: "terminal", small: true });
      console.log(qr);
    } catch {
      // The URL is still usable if the terminal cannot render a QR code.
    }
    return;
  }

  if (command === "channel") {
    const sub = positionals[0];
    const rest = positionals.slice(1);

    if (sub === "list") {
      const result = await client.request<{ channels: Array<{ slug: string; name: string; isDefault: boolean }> }>(
        "GET",
        "/api/channels",
      );
      print(result, asJson, () => {
        for (const channel of result.channels) {
          console.log(`${channel.isDefault ? "*" : " "} ${channel.slug}\t${channel.name}`);
        }
      });
      return;
    }

    if (sub === "create") {
      const name = rest.join(" ").trim();
      if (!name) throw new CliError("Usage: notify channel create <name>");
      const result = await client.request<{ channel: { slug: string; name: string; isDefault: boolean } }>(
        "POST",
        "/api/channels",
        { name, makeDefault: boolValue(values.default) },
      );
      print(result, asJson, () => console.log(`Created ${result.channel.slug}`));
      return;
    }

    if (sub === "delete") {
      const slug = rest[0];
      if (!slug) throw new CliError("Usage: notify channel delete <slug>");
      const result = await client.request<{ deleted: string }>(
        "DELETE",
        `/api/channels/${encodeURIComponent(slug)}`,
      );
      print(result, asJson, () => console.log(`Deleted ${result.deleted}`));
      return;
    }

    if (sub === "set-default") {
      const slug = rest[0];
      if (!slug) throw new CliError("Usage: notify channel set-default <slug>");
      const result = await client.request<{ channel: { slug: string } }>(
        "POST",
        `/api/channels/${encodeURIComponent(slug)}/default`,
      );
      print(result, asJson, () => console.log(`Default channel: ${result.channel.slug}`));
      return;
    }

    throw new CliError("Usage: notify channel list|create|delete|set-default");
  }

  if (command === "device") {
    const sub = positionals[0];
    const rest = positionals.slice(1);

    if (sub === "list") {
      const channel = stringValue(values.channel);
      const query = channel ? `?channel=${encodeURIComponent(channel)}` : "";
      const result = await client.request<{
        devices: Array<{
          id: string;
          label: string;
          subscriptionCount: number;
          activeSubscriptionCount: number;
          lastSeenAt: number;
        }>;
      }>("GET", `/api/devices${query}`);

      print(result, asJson, () => {
        for (const device of result.devices) {
          console.log(
            `${device.id}\t${device.label}\t${device.activeSubscriptionCount}/${device.subscriptionCount} active\t${formatDate(device.lastSeenAt)}`,
          );
        }
      });
      return;
    }

    throw new CliError("Usage: notify device list");
  }

  if (command === "subscription") {
    const sub = positionals[0];
    const rest = positionals.slice(1);

    if (sub === "list") {
      const channel = stringValue(values.channel);
      const query = channel ? `?channel=${encodeURIComponent(channel)}` : "";
      const result = await client.request<{
        subscriptions: Array<{
          id: string;
          deviceLabel: string;
          channel: { slug: string; name: string };
          disabledAt: number | null;
          createdAt: number;
        }>;
      }>("GET", `/api/subscriptions${query}`);

      print(result, asJson, () => {
        for (const subscription of result.subscriptions) {
          console.log(
            `${subscription.id}\t${subscription.channel.slug}\t${subscription.deviceLabel}\t${
              subscription.disabledAt ? "disabled" : "active"
            }`,
          );
        }
      });
      return;
    }

    if (sub === "remove") {
      const id = rest[0];
      if (!id) throw new CliError("Usage: notify subscription remove <subscription-id>");
      const result = await client.request<{ deleted: string }>(
        "DELETE",
        `/api/subscriptions/${encodeURIComponent(id)}`,
      );
      print(result, asJson, () => console.log(`Removed ${result.deleted}`));
      return;
    }

    throw new CliError("Usage: notify subscription list|remove");
  }

  if (command === "notifications") {
    const sub = positionals[0];
    const rest = positionals.slice(1);

    if (sub === "show") {
      const id = rest[0];
      if (!id) throw new CliError("Usage: notify notifications show <id>");

      const result = await client.request<{
        notification: {
          id: string;
          title: string;
          body: string;
          channelSlug: string;
          channelName: string;
          source: string;
          url: string | null;
          tag: string | null;
          createdAt: number;
          sentCount: number;
          failedCount: number;
          deliveries: Array<{
            id: string;
            deviceLabel: string;
            status: string;
            statusCode: number | null;
            error: string | null;
            attemptedAt: number;
          }>;
        };
      }>("GET", `/api/notifications/${encodeURIComponent(id)}`);

      print(result, asJson, () => {
        const notification = result.notification;
        console.log(`${notification.title}  [${notification.channelSlug}]`);
        console.log(
          `${formatDate(notification.createdAt)} · ${notification.sentCount} sent · ${notification.failedCount} failed · source ${notification.source}`,
        );
        console.log(notification.body);
        if (notification.url) console.log(notification.url);
        if (notification.deliveries.length === 0) {
          console.log("No delivery attempts.");
          return;
        }
        for (const delivery of notification.deliveries) {
          const details = [
            delivery.status,
            delivery.statusCode ? `HTTP ${delivery.statusCode}` : "",
            delivery.error ?? "",
          ]
            .filter(Boolean)
            .join(" · ");
          console.log(
            `- ${formatDate(delivery.attemptedAt)}  ${delivery.deviceLabel}  ${details}`,
          );
        }
      });
      return;
    }

    if (sub !== "list") throw new CliError("Usage: notify notifications list|show");
    const params = new URLSearchParams();
    const channel = stringValue(values.channel);
    const limit = stringValue(values.limit);
    if (channel) params.set("channel", channel);
    if (limit) params.set("limit", limit);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";

    const result = await client.request<{
      notifications: Array<{
        id: string;
        channelId: string;
        title: string;
        body: string;
        sentCount: number;
        failedCount: number;
        createdAt: number;
      }>;
    }>("GET", `/api/notifications${suffix}`);

    print(result, asJson, () => {
      for (const notification of result.notifications) {
        console.log(
          `${formatDate(notification.createdAt)}  ${notification.title}  (${notification.sentCount} sent, ${notification.failedCount} failed)`,
        );
      }
    });
    return;
  }

  if (command === "token") {
    const sub = positionals[0];
    const rest = positionals.slice(1);

    if (sub === "list") {
      const result = await client.request<{
        tokens: Array<{
          id: string;
          name: string;
          scopes: string;
          channel_id: string | null;
          created_at: number;
          expires_at: number | null;
          revoked_at: number | null;
        }>;
      }>("GET", "/api/tokens");

      print(result, asJson, () => {
        for (const item of result.tokens) {
          const status = item.revoked_at ? "revoked" : "active";
          console.log(`${item.id}\t${item.name}\t${item.scopes}\t${status}`);
        }
      });
      return;
    }

    if (sub === "create") {
      const name = stringValue(values.name);
      const scopes = multiValue(values.scope);
      if (!name || scopes.length === 0) {
        throw new CliError("Usage: notify token create --name <name> --scope <scope>");
      }

      let expiresAt: number | undefined;
      const expires = stringValue(values["expires-at"]);
      if (expires) {
        const parsed = Date.parse(expires);
        if (!Number.isFinite(parsed)) throw new CliError("Invalid --expires-at date");
        expiresAt = parsed;
      }

      const result = await client.request<{ token: { id: string; token: string; scopes: string[] } }>(
        "POST",
        "/api/tokens",
        {
          name,
          scopes,
          channel: stringValue(values.channel),
          expiresAt,
        },
      );

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Token created. Copy it now; it will not be shown again.");
        console.log(result.token.token);
      }
      return;
    }

    if (sub === "revoke") {
      const id = rest[0];
      if (!id) throw new CliError("Usage: notify token revoke <token-id>");
      const result = await client.request<{ revoked: string }>(
        "DELETE",
        `/api/tokens/${encodeURIComponent(id)}`,
      );
      print(result, asJson, () => console.log(`Revoked ${result.revoked}`));
      return;
    }

    throw new CliError("Usage: notify token list|create|revoke");
  }

  if (command === "setup") {
    const base = baseUrl.replace(/\/+$/, "");
    const health = await client.request<{ ok: boolean; db: boolean }>("GET", "/healthz");
    const config = await client.request<{
      vapidPublicKey: string | null;
      publicUrl: string;
      mcpAdminEnabled: boolean;
      defaultChannel: string;
    }>("GET", "/api/config");

    let authenticated = false;
    let tools: Array<{ name: string; description?: string }> = [];

    if (token) {
      try {
        tools = await client.mcpTools();
        authenticated = true;
      } catch (error) {
        if (error instanceof CliError && error.status !== 401) authenticated = true;
      }
    }

    const publicBase = config.publicUrl.replace(/\/+$/, "");
    const mcpUrl = `${publicBase}/mcp`;
    const contract = {
      server: {
        url: base,
        publicUrl: publicBase,
        mcpUrl,
        agentContract: `${publicBase}/llms.txt`,
        health: health.ok,
        database: health.db,
        vapid: Boolean(config.vapidPublicKey),
        mcpAdminEnabled: config.mcpAdminEnabled,
        defaultChannel: config.defaultChannel,
      },
      auth: {
        type: "bearer",
        header: "Authorization",
        scheme: "Bearer",
        authenticated,
      },
      cli: {
        env: {
          NOTIFY_URL: base,
          NOTIFY_TOKEN: "<token>",
        },
        configPath: "~/.config/notify/config.json",
      },
      opencode: {
        mcp: {
          notify: {
            type: "remote",
            url: mcpUrl,
            enabled: true,
            headers: { Authorization: "Bearer <token>" },
          },
        },
      },
      claudeCode: `claude mcp add --transport http notify ${mcpUrl} --header "Authorization: Bearer <token>"`,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };

    if (asJson) {
      console.log(JSON.stringify(contract, null, 2));
      return;
    }

    console.log(`CLI URL: ${base}`);
    console.log(`Public URL: ${publicBase}`);
    console.log(`MCP: ${mcpUrl}`);
    console.log(`Agent contract: ${publicBase}/llms.txt`);
    console.log(`Health: ${health.ok ? "ok" : "failed"} (db: ${health.db})`);
    console.log(`VAPID: ${config.vapidPublicKey ? "configured" : "missing"}`);
    console.log(`Token: ${authenticated ? "verified" : "missing or invalid"}`);
    console.log(`Default channel: ${config.defaultChannel}`);
    console.log(`MCP admin tools: ${config.mcpAdminEnabled ? "enabled" : "disabled"}`);
    if (tools.length > 0) console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);
    console.log("");
    console.log("OpenCode:");
    console.log(JSON.stringify(contract.opencode, null, 2));
    console.log("");
    console.log("Claude Code:");
    console.log(contract.claudeCode);
    return;
  }

  if (command === "doctor") {
    const health = await client.request<{ ok: boolean; db: boolean }>("GET", "/healthz");
    const config = await client.request<{
      vapidPublicKey: string | null;
      publicUrl: string;
      mcpAdminEnabled: boolean;
      defaultChannel: string;
    }>("GET", "/api/config");

    print({ health, config }, asJson, () => {
      console.log(`Health: ${health.ok ? "ok" : "failed"} (db: ${health.db})`);
      console.log(`Public URL: ${config.publicUrl}`);
      console.log(`VAPID: ${config.vapidPublicKey ? "configured" : "missing"}`);
      console.log(`Default channel: ${config.defaultChannel}`);
      console.log(`MCP admin tools: ${config.mcpAdminEnabled ? "enabled" : "disabled"}`);
    });
    return;
  }

  throw new CliError(`Unknown command: ${command}\n\n${USAGE}`);
}
