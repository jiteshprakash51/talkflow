-- TalkFlow D1/SQLite schema (0001_init.sql also mirrors this)
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title_en TEXT NOT NULL,
  trigger_desc TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_via TEXT NOT NULL DEFAULT 'pwa',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id),
  status TEXT NOT NULL DEFAULT 'ok',
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary_en TEXT NOT NULL DEFAULT '',
  error_en TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  provider TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  secret_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_flow ON runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_msgs_user ON messages(user_id);
