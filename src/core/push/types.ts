import type { PushSubscriptionInput } from "../types";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  statusCode: number;
}

export interface PushSender {
  send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushSendResult>;
}

export class PushSendError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PushSendError";
    this.statusCode = statusCode;
  }
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  timeoutMs: number;
}
