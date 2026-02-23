CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS approval_actions (
  id TEXT PRIMARY KEY NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_ref TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  timestamp TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_ref TEXT,
  status TEXT NOT NULL,
  details_json TEXT,
  error_details TEXT
);

CREATE TABLE IF NOT EXISTS connected_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  account_email TEXT,
  status TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  token_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
