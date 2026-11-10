import { describe, expect, test } from "bun:test";
import { parseDuration, parseTtl } from "../src/cli/duration";

describe("duration", () => {
  test("parses supported units", () => {
    expect(parseDuration("15m")).toBe(15 * 60 * 1000);
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("30s")).toBe(30 * 1000);
  });

  test("rejects invalid values", () => {
    expect(() => parseDuration("15")).toThrow();
    expect(() => parseDuration("0m")).toThrow();
    expect(() => parseDuration("soon")).toThrow();
  });

  test("enforces register TTL bounds", () => {
    expect(parseTtl("1m")).toBe(60_000);
    expect(parseTtl("24h")).toBe(24 * 60 * 60 * 1000);
    expect(() => parseTtl("30s")).toThrow("at least 1m");
    expect(() => parseTtl("25h")).toThrow("at most 24h");
  });
});
