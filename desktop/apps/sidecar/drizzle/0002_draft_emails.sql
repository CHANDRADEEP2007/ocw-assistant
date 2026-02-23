CREATE TABLE IF NOT EXISTS draft_emails (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT,
  bcc_json TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  source_prompt TEXT,
  tone TEXT,
  status TEXT NOT NULL,
  approval_action_id TEXT,
  gmail_message_id TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES connected_accounts(id),
  FOREIGN KEY(approval_action_id) REFERENCES approval_actions(id)
);

CREATE INDEX IF NOT EXISTS idx_draft_emails_status ON draft_emails(status);
CREATE INDEX IF NOT EXISTS idx_draft_emails_account_id ON draft_emails(account_id);
