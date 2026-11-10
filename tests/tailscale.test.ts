import { describe, expect, test } from "bun:test";
import {
  parseTailscaleStatus,
  serveStatusHasPort,
  tailscaleUrl,
} from "../src/server/tailscale";

describe("tailscale helpers", () => {
  test("reads the MagicDNS name", () => {
    const json = JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "machine.example-tailnet.ts.net." },
    });

    expect(parseTailscaleStatus(json)).toBe("machine.example-tailnet.ts.net");
  });

  test("rejects a stopped tailnet", () => {
    expect(() =>
      parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: {} })),
    ).toThrow("not running");
  });

  test("rejects a missing DNS name", () => {
    expect(() =>
      parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: {} })),
    ).toThrow("MagicDNS");
  });

  test("detects an existing serve port", () => {
    const json = JSON.stringify({
      Web: {
        "machine.example-tailnet.ts.net:443": { Handlers: {} },
        "machine.example-tailnet.ts.net:8443": { Handlers: {} },
      },
    });

    expect(serveStatusHasPort(json, 8443)).toBe(true);
    expect(serveStatusHasPort(json, 9443)).toBe(false);
    expect(serveStatusHasPort("not json", 8443)).toBe(false);
  });

  test("builds the public URL", () => {
    expect(tailscaleUrl("machine.example-tailnet.ts.net", 443)).toBe(
      "https://machine.example-tailnet.ts.net",
    );
    expect(tailscaleUrl("machine.example-tailnet.ts.net", 8443)).toBe(
      "https://machine.example-tailnet.ts.net:8443",
    );
  });
});
