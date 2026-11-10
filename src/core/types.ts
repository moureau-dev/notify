import { ForbiddenError } from "./errors";

export const SCOPES = [
  "notify:send",
  "notify:read",
  "channels:read",
  "channels:write",
  "devices:read",
  "devices:write",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export interface AuthContext {
  tokenId: string;
  name: string;
  scopes: Set<string>;
  channelId: string | null;
  expiresAt: number | null;
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  createdAt: number;
}

export interface Device {
  id: string;
  label: string;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface Subscription {
  id: string;
  deviceId: string;
  channelId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
  disabledAt: number | null;
  failureCount: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NotificationRecord {
  id: string;
  channelId: string;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
  dataJson: string | null;
  source: string;
  sentCount: number;
  failedCount: number;
  createdAt: number;
}

export interface NotificationResult {
  notificationId: string;
  channel: string;
  sent: number;
  failed: number;
  disabled: number;
  skipped: boolean;
}

export function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.has("admin") || auth.scopes.has(scope);
}

export function assertScope(auth: AuthContext, scope: string): void {
  if (!hasScope(auth, scope)) {
    throw new ForbiddenError(`Missing scope: ${scope}`);
  }
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.scopes.has("admin");
}
