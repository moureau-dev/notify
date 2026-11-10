import type { DB } from "../db";
import { audit } from "./audit";
import { randomToken } from "./crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { AuthContext, Channel } from "./types";

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  is_default: number;
  created_at: number;
}

function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63);
}

export function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new ValidationError(
      "Channel slug must be 1-63 lowercase letters, numbers, or dashes, and start with a letter or number",
    );
  }
}

export function getChannelBySlug(db: DB, slug: string): Channel | null {
  const row = db.query("SELECT * FROM channels WHERE slug = ?").get(slug) as ChannelRow | null;
  return row ? mapChannel(row) : null;
}

export function getChannelById(db: DB, id: string): Channel | null {
  const row = db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null;
  return row ? mapChannel(row) : null;
}

export function getDefaultChannel(db: DB): Channel {
  const row = db.query("SELECT * FROM channels WHERE is_default = 1").get() as ChannelRow | null;
  if (!row) throw new NotFoundError("No default channel is configured");
  return mapChannel(row);
}

export function listChannels(db: DB, auth?: AuthContext): Channel[] {
  if (auth?.channelId) {
    const channel = getChannelById(db, auth.channelId);
    return channel ? [channel] : [];
  }

  const rows = db
    .query("SELECT * FROM channels ORDER BY is_default DESC, name ASC")
    .all() as ChannelRow[];
  return rows.map(mapChannel);
}

export function createChannel(
  db: DB,
  input: {
    name: string;
    slug?: string;
    makeDefault?: boolean;
    actor?: string | null;
    ip?: string | null;
  },
): Channel {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Channel name is required");

  const slug = input.slug ? slugify(input.slug) : slugify(name);
  assertValidSlug(slug);

  const now = Date.now();
  const id = `ch_${randomToken(10)}`;

  const transaction = db.transaction(() => {
    if (input.makeDefault) {
      db.query("UPDATE channels SET is_default = 0 WHERE is_default = 1").run();
    }

    db.query(
      "INSERT INTO channels (id, slug, name, is_default, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, slug, name, input.makeDefault ? 1 : 0, now);
  });

  try {
    transaction();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new ConflictError(`Channel "${slug}" already exists`);
    throw error;
  }

  audit(db, {
    actor: input.actor,
    action: "channel.created",
    target: slug,
    channelId: id,
    outcome: "success",
    ip: input.ip,
  });

  return { id, slug, name, isDefault: Boolean(input.makeDefault), createdAt: now };
}

export function getOrCreateChannel(
  db: DB,
  input: { name: string; actor?: string | null; ip?: string | null },
): { channel: Channel; created: boolean } {
  const slug = slugify(input.name);
  assertValidSlug(slug);

  const existing = getChannelBySlug(db, slug);
  if (existing) return { channel: existing, created: false };

  const now = Date.now();
  const id = `ch_${randomToken(10)}`;

  const result = db
    .query(
      `INSERT INTO channels (id, slug, name, is_default, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (slug) DO NOTHING`,
    )
    .run(id, slug, input.name.trim(), now);

  if (result.changes > 0) {
    audit(db, {
      actor: input.actor,
      action: "channel.created",
      target: slug,
      channelId: id,
      outcome: "success",
      ip: input.ip,
    });
    return { channel: { id, slug, name: input.name.trim(), isDefault: false, createdAt: now }, created: true };
  }

  const channel = getChannelBySlug(db, slug);
  if (!channel) throw new ConflictError("Could not create channel");
  return { channel, created: false };
}

export function setDefaultChannel(
  db: DB,
  slug: string,
  actor?: string | null,
  ip?: string | null,
): Channel {
  const channel = getChannelBySlug(db, slug);
  if (!channel) throw new NotFoundError("Channel not found");

  const transaction = db.transaction(() => {
    db.query("UPDATE channels SET is_default = 0 WHERE is_default = 1").run();
    db.query("UPDATE channels SET is_default = 1 WHERE id = ?").run(channel.id);
  });
  transaction();

  audit(db, {
    actor,
    action: "channel.default_changed",
    target: slug,
    channelId: channel.id,
    outcome: "success",
    ip,
  });

  return { ...channel, isDefault: true };
}

export function deleteChannel(
  db: DB,
  slug: string,
  actor?: string | null,
  ip?: string | null,
): void {
  const channel = getChannelBySlug(db, slug);
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.isDefault) throw new ConflictError("The default channel cannot be deleted");

  const count = (
    db.query("SELECT COUNT(*) AS count FROM subscriptions WHERE channel_id = ?").get(channel.id) as {
      count: number;
    }
  ).count;

  if (count > 0) {
    throw new ConflictError("Channel still has subscriptions; remove them first");
  }

  db.query("DELETE FROM channels WHERE id = ?").run(channel.id);

  audit(db, {
    actor,
    action: "channel.deleted",
    target: slug,
    channelId: channel.id,
    outcome: "success",
    ip,
  });
}

export function assertChannelAccess(auth: AuthContext, channelId: string): void {
  if (auth.channelId && auth.channelId !== channelId) {
    throw new ForbiddenError("Token is not allowed to access this channel");
  }
}

export function resolveChannel(
  db: DB,
  auth: AuthContext,
  requested?: string | null,
): Channel {
  if (auth.channelId) {
    const scoped = getChannelById(db, auth.channelId);
    if (!scoped) throw new NotFoundError("Channel not found");

    if (requested && requested !== scoped.slug && requested !== scoped.id) {
      throw new ForbiddenError("Token is not allowed to access this channel");
    }

    return scoped;
  }

  if (requested) {
    const channel = getChannelBySlug(db, requested);
    if (!channel) throw new NotFoundError("Channel not found");
    return channel;
  }

  return getDefaultChannel(db);
}
