import { describe, expect, test } from "bun:test";
import { parseServeArgs } from "../src/server/serve-args";

describe("serve args", () => {
  test("defaults", () => {
    expect(parseServeArgs([])).toEqual({
      dev: false,
      tailscale: false,
      tailscalePort: 8443,
      tailscaleForce: false,
      tailscaleKeep: false,
    });
  });

  test("parses tailscale flags", () => {
    expect(
      parseServeArgs([
        "--dev",
        "--tailscale",
        "--tailscale-port",
        "9443",
        "--tailscale-force",
        "--tailscale-keep",
      ]),
    ).toEqual({
      dev: true,
      tailscale: true,
      tailscalePort: 9443,
      tailscaleForce: true,
      tailscaleKeep: true,
    });
  });

  test("supports equals form", () => {
    expect(parseServeArgs(["--tailscale-port=443"]).tailscalePort).toBe(443);
  });

  test("rejects bad ports", () => {
    expect(() => parseServeArgs(["--tailscale-port", "0"])).toThrow();
    expect(() => parseServeArgs(["--tailscale-port", "70000"])).toThrow();
    expect(() => parseServeArgs(["--tailscale-port"])).toThrow();
    expect(() => parseServeArgs(["--tailscale-port=abc"])).toThrow();
  });
});
