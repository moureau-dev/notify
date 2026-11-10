CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_channels_default ON channels (is_default) WHERE is_default = 1;

INSERT INTO channels (id, slug, name, is_default, created_at)
VALUES ('ch_default', 'default', 'Default', 1, unixepoch() * 1000);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  user_agent TEXT,
  session_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_devices_session_hash ON devices (session_hash) WHERE session_hash IS NOT NULL;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (channel_id, endpoint)
);

CREATE INDEX idx_subscriptions_device ON subscriptions (device_id);
CREATE INDEX idx_subscriptions_channel ON subscriptions (channel_id);

CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  label TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX idx_enrollment_tokens_channel ON enrollment_tokens (channel_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  channel_id TEXT REFERENCES channels (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE INDEX idx_api_tokens_channel ON api_tokens (channel_id);
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (token_hash);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  tag TEXT,
  data_json TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_notifications_channel_created ON notifications (channel_id, created_at DESC);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_code INTEGER,
  error TEXT,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX idx_deliveries_notification ON deliveries (notification_id);
CREATE INDEX idx_deliveries_subscription ON deliveries (subscription_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  channel_id TEXT,
  outcome TEXT NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_events_created ON audit_events (created_at DESC);
CREATE INDEX idx_audit_events_channel ON audit_events (channel_id, created_at DESC);
