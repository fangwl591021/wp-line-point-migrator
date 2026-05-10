CREATE TABLE IF NOT EXISTS line_channels (
  channel_key TEXT PRIMARY KEY,
  label TEXT,
  forward_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_key TEXT NOT NULL,
  line_user_id TEXT,
  event_type TEXT,
  message_type TEXT,
  message_text TEXT,
  reply_token TEXT,
  line_timestamp INTEGER,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_channel_user
  ON webhook_events(channel_key, line_user_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at);

CREATE TABLE IF NOT EXISTS line_identity_observations (
  channel_key TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(channel_key, line_user_id)
);

CREATE TABLE IF NOT EXISTS binding_codes (
  code TEXT PRIMARY KEY,
  master_member_ref TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS member_line_links (
  master_member_ref TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  binding_code TEXT,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(master_member_ref, channel_key),
  UNIQUE(channel_key, line_user_id)
);

CREATE TABLE IF NOT EXISTS point_accounts (
  account_key TEXT PRIMARY KEY,
  master_member_ref TEXT,
  channel_key TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  point_type TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_key, line_user_id, point_type)
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key TEXT NOT NULL,
  master_member_ref TEXT,
  channel_key TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  point_type TEXT NOT NULL,
  point_delta REAL NOT NULL,
  balance_after REAL NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT,
  business_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(account_key) REFERENCES point_accounts(account_key)
);

CREATE INDEX IF NOT EXISTS idx_point_ledger_channel_user
  ON point_ledger(channel_key, line_user_id);

CREATE INDEX IF NOT EXISTS idx_point_ledger_master_member
  ON point_ledger(master_member_ref);
