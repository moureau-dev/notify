import { describe, expect, test } from "bun:test";
import { consumeEnrollment, createEnrollment } from "../src/core/enrollment";
import { makeDb, testChannel } from "./helpers";

describe("enrollment tokens", () => {
  test("creates a URL and consumes once", () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      label: "MacBook",
      publicUrl: "http://localhost:8787",
    });

    expect(enrollment.url).toContain("/enroll?token=");

    const consumed = consumeEnrollment(db, enrollment.token);
    expect(consumed.channelId).toBe(channel.id);
    expect(consumed.label).toBe("MacBook");

    expect(() => consumeEnrollment(db, enrollment.token)).toThrow("Invalid or expired");
  });

  test("rejects expired tokens", () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      publicUrl: "http://localhost:8787",
      ttlMs: -1000,
    });

    expect(() => consumeEnrollment(db, enrollment.token)).toThrow("Invalid or expired");
  });

  test("rejects tampered tokens", () => {
    const db = makeDb();
    const channel = testChannel(db, "alice");

    const enrollment = createEnrollment(db, {
      channelId: channel.id,
      publicUrl: "http://localhost:8787",
    });

    const tampered = `${enrollment.token.slice(0, -1)}x`;
    expect(() => consumeEnrollment(db, tampered)).toThrow("Invalid or expired");
  });
});
