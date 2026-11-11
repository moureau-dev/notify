import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import { makeDb, FakePushSender, testConfig, testToken } from "./helpers";

async function mcpRequest(
  app: ReturnType<typeof createApp>,
  token: string | undefined,
  body: unknown,
) {
  const headers = new Headers({
    Host: "localhost",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("mcp", () => {
  test("requires a bearer token", async () => {
    const db = makeDb();
    const app = createApp({
      config: testConfig({ mcpAdminEnabled: true }),
      db,
      pushSender: new FakePushSender(),
    });

    const response = await mcpRequest(app, undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("lists tools and hides admin tools by default", async () => {
    const db = makeDb();
    const token = testToken(db, ["channels:read"]);
    const app = createApp({
      config: testConfig({ mcpAdminEnabled: false }),
      db,
      pushSender: new FakePushSender(),
    });

    const response = await mcpRequest(app, token.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("list_channels");
    expect(text).toContain("notify");
    expect(text).not.toContain("create_channel");
    expect(text).not.toContain("register_device");
  });

  test("calls a scoped tool", async () => {
    const db = makeDb();
    const token = testToken(db, ["channels:read"]);
    const app = createApp({
      config: testConfig({ mcpAdminEnabled: false }),
      db,
      pushSender: new FakePushSender(),
    });

    const response = await mcpRequest(app, token.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_channels", arguments: {} },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("default");
  });

  test("register_device returns an enrollment URL and QR code", async () => {
    const db = makeDb();
    const token = testToken(db, ["admin"]);
    const app = createApp({
      config: testConfig({ mcpAdminEnabled: true }),
      db,
      pushSender: new FakePushSender(),
    });

    const response = await mcpRequest(app, token.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "register_device",
        arguments: { channel: "qr-test", ttlMs: 60_000 },
      },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine ? dataLine.slice(6) : text) as {
      result: {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
    };
    const content = payload.result.content;

    expect(
      content.some(
        (item) => item.type === "text" && item.text?.includes("/enroll?token=") === true,
      ),
    ).toBe(true);
    expect(
      content.some(
        (item) =>
          item.type === "image" &&
          item.mimeType === "image/png" &&
          typeof item.data === "string" &&
          item.data.length > 100,
      ),
    ).toBe(true);
    expect(
      content.some((item) => item.type === "text" && (item.text?.length ?? 0) > 200),
    ).toBe(true);
  });

  test("rejects a tool without the required scope", async () => {
    const db = makeDb();
    const token = testToken(db, ["channels:read"]);
    const app = createApp({
      config: testConfig({ mcpAdminEnabled: false }),
      db,
      pushSender: new FakePushSender(),
    });

    const response = await mcpRequest(app, token.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "notify", arguments: { body: "hello" } },
    });

    expect(response.status).toBe(403);
  });
});
