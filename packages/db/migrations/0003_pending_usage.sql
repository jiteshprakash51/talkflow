CREATE TABLE IF NOT EXISTS pending (
  user_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_providers (
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);
CREATE TABLE IF NOT EXISTS usage_users (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  chats INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
