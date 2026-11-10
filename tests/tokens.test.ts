import { describe, expect, test } from "bun:test";
import {
  createApiToken,
  ensureBootstrapToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "../src/core/tokens";
import { makeDb, testChannel } from "./helpers";

describe("api tokens", () => {
  test("creates, verifies, lists, and revokes a token", () => {
    const db = makeDb();
    const created = createApiToken(db, {
      name: "agent",
      scopes: ["notify:send"],
    });

    expect(created.token.startsWith("ntk_")).toBe(true);

    const auth = verifyApiToken(db, created.token);
    expect(auth?.tokenId).toBe(created.id);
    expect(auth?.scopes.has("notify:send")).toBe(true);

    expect(listApiTokens(db)[0]?.name).toBe("agent");

    revokeApiToken(db, created.id);
    expect(verifyApiToken(db, created.token)).toBeNull();
  });

  test("rejects an expired token", () => {
    const db = makeDb();
    const created = createApiToken(db, {
      name: "expired",
      scopes: ["notify:send"],
      expiresAt: Date.now() - 1000,
    });

    expect(verifyApiToken(db, created.token)).toBeNull();
  });

  test("scopes a token to a channel", () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");
    const created = createApiToken(db, {
      name: "alice",
      scopes: ["notify:send", "devices:read"],
      channelId: channel.id,
    });

    const auth = verifyApiToken(db, created.token);
    expect(auth?.channelId).toBe(channel.id);
  });

  test("refuses an admin token scoped to a channel", () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");

    expect(() =>
      createApiToken(db, {
        name: "bad",
        scopes: ["admin"],
        channelId: channel.id,
      }),
    ).toThrow();
  });

  test("bootstraps the first admin token and verifies raw bootstrap secrets", () => {
    const db = makeDb();
    const bootstrap = "a".repeat(32);

    ensureBootstrapToken(db, bootstrap);

    const auth = verifyApiToken(db, bootstrap);
    expect(auth?.scopes.has("admin")).toBe(true);

    revokeApiToken(db, "bootstrap");
    expect(verifyApiToken(db, bootstrap)).toBeNull();
  });

  test("fails closed without a bootstrap token", () => {
    const db = makeDb();
    expect(() => ensureBootstrapToken(db, null)).toThrow("NOTIFY_BOOTSTRAP_TOKEN");
  });
});
