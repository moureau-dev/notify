import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as z from "zod/v4";
import * as webpush from "web-push";

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => value === "1" || value === "true");

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(32).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(8787),
  DATABASE_PATH: z.string().default("data/notify.sqlite"),
  PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:notify@example.com"),
  NOTIFY_BOOTSTRAP_TOKEN: optionalSecret,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: boolFromEnv,
  MCP_ADMIN_ENABLED: boolFromEnv,
  PUSH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  PUSH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  PUSH_ENDPOINT_ALLOWLIST: z.string().optional(),
});

export const DEFAULT_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "web.push.apple.com",
  "push.apple.com",
] as const;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface Config {
  env: "development" | "test" | "production";
  isProduction: boolean;
  host: string;
  port: number;
  databasePath: string;
  publicUrl: string;
  publicOrigin: string;
  publicHostname: string;
  vapid: VapidConfig | null;
  bootstrapToken: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  trustProxy: boolean;
  mcpAdminEnabled: boolean;
  pushTimeoutMs: number;
  pushConcurrency: number;
  retentionDays: number;
  pushHosts: string[];
  cookieName: string;
  cookieSecure: boolean;
  allowedHosts: string[];
}

export interface LoadConfigOptions {
  requireVapid?: boolean;
  dev?: boolean;
}

function loadDevVapid(): VapidConfig {
  const file = resolve("data/dev-vapid.json");

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<VapidConfig>;
    if (parsed.publicKey && parsed.privateKey) {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: parsed.subject ?? "mailto:notify@localhost",
      };
    }
  } catch {
    // Generate a new development keypair below.
  }

  const keys = webpush.generateVAPIDKeys();
  const vapid = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "mailto:notify@localhost",
  };

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(vapid, null, 2)}\n`, { mode: 0o600 });
  return vapid;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = envSchema.parse(process.env);
  const publicUrl = new URL(env.PUBLIC_URL);
  const publicOrigin = publicUrl.origin;
  const publicHostname = publicUrl.hostname;

  const isProduction = env.NODE_ENV === "production";

  if (isProduction && env.HOST !== "127.0.0.1" && publicUrl.protocol !== "https:") {
    throw new Error(
      "Refusing to bind a public host without HTTPS. Set PUBLIC_URL to an https:// URL or bind HOST=127.0.0.1.",
    );
  }

  let vapid: VapidConfig | null = null;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    vapid = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    };
  } else if (options.requireVapid) {
    if (options.dev && !isProduction) {
      vapid = loadDevVapid();
    } else {
      throw new Error(
        "VAPID keys are required. Run `notify vapid generate` and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT.",
      );
    }
  }

  const pushHosts = env.PUSH_ENDPOINT_ALLOWLIST
    ? env.PUSH_ENDPOINT_ALLOWLIST.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
    : [...DEFAULT_PUSH_HOSTS];

  const allowedHosts = [...new Set([publicHostname, "localhost", "127.0.0.1"])];

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    databasePath: env.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(env.DATABASE_PATH),
    publicUrl: publicOrigin,
    publicOrigin,
    publicHostname,
    vapid,
    bootstrapToken: env.NOTIFY_BOOTSTRAP_TOKEN?.trim() || null,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    mcpAdminEnabled: env.MCP_ADMIN_ENABLED,
    pushTimeoutMs: env.PUSH_TIMEOUT_MS,
    pushConcurrency: env.PUSH_CONCURRENCY,
    retentionDays: env.RETENTION_DAYS,
    pushHosts,
    cookieName: publicUrl.protocol === "https:" ? "__Host-notify_device" : "notify_device",
    cookieSecure: publicUrl.protocol === "https:",
    allowedHosts,
  };
}
