import { ValidationError } from "../errors";
import type { PushSubscriptionInput } from "../types";

function base64UrlLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return -1;

  try {
    return Buffer.from(value, "base64url").length;
  } catch {
    return -1;
  }
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function assertSafePushEndpoint(endpoint: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError("Invalid push subscription endpoint");
  }

  if (url.protocol !== "https:") {
    throw new ValidationError("Push subscription endpoint must use https");
  }

  if (url.username || url.password) {
    throw new ValidationError("Push subscription endpoint must not include credentials");
  }

  if (url.port && url.port !== "443") {
    throw new ValidationError("Push subscription endpoint must use the default https port");
  }

  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname) || hostname.endsWith(".local")) {
    throw new ValidationError("Push subscription endpoint host is not allowed");
  }

  const allowed = allowedHosts.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  if (!allowed) {
    throw new ValidationError("Push subscription endpoint host is not allowed");
  }

  return url;
}

export function assertValidPushSubscription(
  subscription: PushSubscriptionInput,
  allowedHosts: readonly string[],
): void {
  assertSafePushEndpoint(subscription.endpoint, allowedHosts);

  const p256dhLength = base64UrlLength(subscription.keys.p256dh);
  const authLength = base64UrlLength(subscription.keys.auth);

  if (p256dhLength !== 65) {
    throw new ValidationError("Invalid push subscription p256dh key");
  }

  if (authLength !== 16) {
    throw new ValidationError("Invalid push subscription auth secret");
  }
}

export function assertSafeNotificationUrl(url: string | undefined, allowHttp: boolean): void {
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid notification URL");
  }

  const allowedProtocol =
    parsed.protocol === "https:" ||
    (allowHttp && (parsed.protocol === "http:" || parsed.protocol === "https:"));

  if (!allowedProtocol) {
    throw new ValidationError("Notification URL must use https");
  }

  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new ValidationError("Notification URL must use https");
  }
}
