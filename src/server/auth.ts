import type { Config } from "../config";
import type { DB } from "../db";
import { verifyDeviceToken } from "../core/devices";
import { UnauthorizedError } from "../core/errors";
import { verifyApiToken } from "../core/tokens";
import type { AuthContext, Device } from "../core/types";
import { parseCookies, serializeCookie } from "./http";

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function authenticate(db: DB, request: Request): AuthContext {
  const token = extractBearer(request);
  if (!token) throw new UnauthorizedError();

  const auth = verifyApiToken(db, token);
  if (!auth) throw new UnauthorizedError("Invalid or expired token");

  return auth;
}

export function getDeviceFromRequest(
  db: DB,
  request: Request,
  config: Config,
): Device | null {
  const cookies = parseCookies(request);
  const token = cookies[config.cookieName];
  if (!token) return null;
  return verifyDeviceToken(db, token);
}

export function deviceCookieHeader(config: Config, token: string): string {
  return serializeCookie(config.cookieName, token, { secure: config.cookieSecure });
}
