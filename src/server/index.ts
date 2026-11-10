import { loadConfig } from "../config";
import { closeDatabase, openAndMigrate } from "../db";
import { pruneOldData } from "../core/notifications";
import { createWebPushSender } from "../core/push/web-push";
import { ensureBootstrapToken } from "../core/tokens";
import { createApp, type AppDeps } from "./app";
import { parseServeArgs } from "./serve-args";
import {
  prepareTailscale,
  startTailscaleServe,
  stopTailscaleServe,
  type PreparedTailscale,
} from "./tailscale";

export async function startServer(args: string[] = []): Promise<void> {
  const options = parseServeArgs(args);
  if (options.dev) process.env.NODE_ENV = "development";

  let tailscale: PreparedTailscale | null = null;

  if (options.tailscale) {
    tailscale = prepareTailscale(options.tailscalePort, options.tailscaleForce);
    process.env.PUBLIC_URL = tailscale.publicUrl;
    process.env.HOST = "127.0.0.1";
    process.env.TRUST_PROXY = "true";
  }

  const config = loadConfig({ requireVapid: true, dev: options.dev });
  const db = openAndMigrate(config.databasePath);
  let dbClosed = false;

  const closeDb = () => {
    if (dbClosed) return;
    dbClosed = true;
    closeDatabase(db);
  };

  try {
    ensureBootstrapToken(db, config.bootstrapToken);

    if (config.bootstrapToken && !config.isProduction) {
      console.warn(
        "[notify] NOTIFY_BOOTSTRAP_TOKEN is set. Create a named admin token, then remove it and revoke `bootstrap`.",
      );
    }

    const pushSender = config.vapid
      ? createWebPushSender({
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
          subject: config.vapid.subject,
          timeoutMs: config.pushTimeoutMs,
        })
      : null;

    const deps: AppDeps = { config, db, pushSender };
    const app = createApp(deps);

    pruneOldData(db, config.retentionDays);

    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 30,
      maxRequestBodySize: 64 * 1024,
      fetch: (request, bunServer) => app.fetch(request, bunServer),
    });

    let tailscaleStarted = false;

    if (tailscale) {
      try {
        startTailscaleServe(server.port ?? config.port, options.tailscalePort);
        tailscaleStarted = true;
      } catch (error) {
        server.stop(true);
        closeDb();
        throw error;
      }

      console.log(
        `[notify] tailnet proxy: ${tailscale.publicUrl} -> http://127.0.0.1:${server.port}`,
      );

      if (options.tailscaleKeep) {
        console.log("[notify] --tailscale-keep: leaving the Tailscale Serve handler in place.");
      } else {
        console.log(
          `[notify] stop the proxy with: tailscale serve --https=${options.tailscalePort} off`,
        );
      }
    }

    console.log(
      `[notify] listening on http://${config.host}:${server.port} (${config.env}) — ${config.publicUrl}`,
    );
    console.log(`[notify] MCP admin tools: ${config.mcpAdminEnabled ? "enabled" : "disabled"}`);

    const retentionTimer = setInterval(
      () => {
        try {
          pruneOldData(db, config.retentionDays);
        } catch (error) {
          console.error("[notify] retention cleanup failed", error);
        }
      },
      24 * 60 * 60 * 1000,
    );

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`[notify] shutting down (${signal})`);
      clearInterval(retentionTimer);
      server.stop(true);

      if (tailscaleStarted && !options.tailscaleKeep) {
        stopTailscaleServe(options.tailscalePort);
      }

      closeDb();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    closeDb();
    throw error;
  }
}
