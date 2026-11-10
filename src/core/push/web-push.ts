import * as webpush from "web-push";
import type { PushSubscriptionInput } from "../types";
import {
  PushSendError,
  type PushPayload,
  type PushSendResult,
  type PushSender,
  type WebPushConfig,
} from "./types";

export class WebPushSender implements PushSender {
  constructor(private config: WebPushConfig) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  async send(
    subscription: PushSubscriptionInput,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    try {
      const result = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        JSON.stringify(payload),
        {
          TTL: 3600,
          urgency: "normal",
          timeout: this.config.timeoutMs,
        },
      );

      return { statusCode: result.statusCode };
    } catch (error) {
      const candidate = error as { statusCode?: number; body?: string; message?: string };
      throw new PushSendError(
        candidate.statusCode ?? 0,
        candidate.body || candidate.message || "Push delivery failed",
      );
    }
  }
}

export function createWebPushSender(config: WebPushConfig): PushSender {
  return new WebPushSender(config);
}
