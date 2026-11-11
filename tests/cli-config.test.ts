import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "../src/cli/client";

const originalUrl = process.env.NOTIFY_URL;
const originalToken = process.env.NOTIFY_TOKEN;
const originalConfig = process.env.NOTIFY_CONFIG;
let tempDir: string | null = null;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.NOTIFY_URL;
  else process.env.NOTIFY_URL = originalUrl;
  if (originalToken === undefined) delete process.env.NOTIFY_TOKEN;
  else process.env.NOTIFY_TOKEN = originalToken;
  if (originalConfig === undefined) delete process.env.NOTIFY_CONFIG;
  else process.env.NOTIFY_CONFIG = originalConfig;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("cli config", () => {
  test("uses the stored URL when NOTIFY_URL is not set", () => {
    tempDir = mkdtempSync(join(tmpdir(), "notify-cli-"));
    const path = join(tempDir, "config.json");
    writeFileSync(path, JSON.stringify({ url: "https://notify.example.com", token: "stored" }));

    delete process.env.NOTIFY_URL;
    delete process.env.NOTIFY_TOKEN;
    process.env.NOTIFY_CONFIG = path;

    expect(loadCliConfig()).toEqual({
      url: "https://notify.example.com",
      token: "stored",
    });
  });

  test("environment overrides the stored config", () => {
    tempDir = mkdtempSync(join(tmpdir(), "notify-cli-"));
    const path = join(tempDir, "config.json");
    writeFileSync(path, JSON.stringify({ url: "https://stored.example.com", token: "stored" }));

    process.env.NOTIFY_URL = "https://env.example.com";
    process.env.NOTIFY_TOKEN = "env";
    process.env.NOTIFY_CONFIG = path;

    expect(loadCliConfig()).toEqual({
      url: "https://env.example.com",
      token: "env",
    });
  });
});
