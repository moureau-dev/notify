import { timingSafeEqual } from "node:crypto";

export const API_TOKEN_PREFIX = "ntk";
export const ENROLLMENT_TOKEN_PREFIX = "ent";
export const DEVICE_TOKEN_PREFIX = "dvt";

export interface OpaqueToken {
  id: string;
  secret: string;
  token: string;
  hash: string;
}

export function randomToken(bytes = 32): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(buffer).toString("hex");
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex") as string;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createOpaqueToken(prefix: string): OpaqueToken {
  const id = randomToken(9);
  const secret = randomToken(32);
  return {
    id,
    secret,
    token: `${prefix}_${id}_${secret}`,
    hash: sha256Hex(secret),
  };
}

export function parseOpaqueToken(token: string, prefix: string): { id: string; secret: string } | null {
  const parts = token.split("_");
  if (parts.length !== 3) return null;
  const [actualPrefix, id, secret] = parts;
  if (actualPrefix !== prefix || !id || !secret) return null;
  return { id, secret };
}

export function verifyOpaqueToken(token: string, prefix: string, id: string, hash: string): boolean {
  const parsed = parseOpaqueToken(token, prefix);
  if (!parsed || parsed.id !== id) return false;
  return safeEqual(sha256Hex(parsed.secret), hash);
}
