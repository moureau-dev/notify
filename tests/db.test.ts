import { describe, expect, test } from "bun:test";
import { getDefaultChannel } from "../src/core/channels";
import { openAndMigrate, runMigrations } from "../src/db";
import { makeDb } from "./helpers";

describe("migrations", () => {
  test("creates the default channel and records migrations", () => {
    const db = makeDb();
    expect(getDefaultChannel(db).slug).toBe("default");

    const applied = db.query("SELECT name FROM _migrations").all() as Array<{ name: string }>;
    expect(applied.map((row) => row.name)).toEqual(["0001_initial_schema.up.sql"]);
  });

  test("is idempotent", () => {
    const db = makeDb();
    expect(runMigrations(db)).toEqual([]);
  });

  test("enables foreign keys", () => {
    const db = openAndMigrate(":memory:");
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });
});
