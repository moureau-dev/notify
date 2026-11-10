import * as z from "zod/v4";
import type { Config } from "../config";
import {
  AppError,
  isAppError,
  PayloadTooLargeError,
  RateLimitError,
  ValidationError,
} from "../core/errors";

export interface RequestServer {
  requestIP(request: Request): { address: string; family: string; port: number } | null;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  if (error instanceof RateLimitError) {
    return json(
      { error: { code: error.code, message: error.message }, requestId },
      { status: error.status, headers: { "Retry-After": String(error.retryAfter) } },
    );
  }

  if (isAppError(error)) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details }, requestId },
      { status: error.status },
    );
  }

  console.error("[notify] unhandled error", error);
  return json(
    { error: { code: "internal_error", message: "Internal server error" }, requestId },
    { status: 500 },
  );
}

export function applySecurityHeaders(
  response: Response,
  config: Config,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Permissions-Policy",
    "notifications=(self), camera=(), microphone=(), geolocation=()",
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  );

  if (config.cookieSecure) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  headers.set("X-Request-Id", requestId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ValidationError("Content-Type must be application/json");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new PayloadTooLargeError();

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new PayloadTooLargeError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new ValidationError("Invalid JSON body");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError("Invalid request body", result.error.issues);
  }

  return result.data;
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie");
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds?: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${options.maxAgeSeconds ?? 365 * 24 * 60 * 60}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { secure, maxAgeSeconds: 0 });
}

export function getClientIp(
  request: Request,
  config: Config,
  server?: RequestServer,
): string {
  if (config.trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }

  try {
    return server?.requestIP(request)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function methodNotAllowed(allow: string): Response {
  return json(
    { error: { code: "method_not_allowed", message: "Method not allowed" } },
    { status: 405, headers: { Allow: allow } },
  );
}

export function notFound(): Response {
  return json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

export function isAppErrorInstance(error: unknown): error is AppError {
  return isAppError(error);
}
