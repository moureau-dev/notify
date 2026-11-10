import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type DB = Database;

export interface DatabaseOptions {
  migrationsDir?: string;
}

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // The volume may not support chmod; the process still owns the file.
    }
  }

  return db;
}

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(import.meta.dir, "migrations");
}

export function runMigrations(db: Database, options: DatabaseOptions = {}): string[] {
  const directory = options.migrationsDir ?? defaultMigrationsDir();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      executed_at INTEGER NOT NULL
    );
  `);

  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".up.sql"))
    .sort((a, b) => a.localeCompare(b));

  const applied = new Set(
    db
      .query("SELECT name FROM _migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const executed: string[] = [];
  const record = db.query("INSERT INTO _migrations (name, executed_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(directory, file), "utf8");
    const transaction = db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    });

    transaction();
    executed.push(file);
  }

  return executed;
}

export function openAndMigrate(path: string, options: DatabaseOptions = {}): Database {
  const db = openDatabase(path);
  runMigrations(db, options);
  return db;
}

export function closeDatabase(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Best effort; closing still releases the handle.
  }
  db.close();
}
