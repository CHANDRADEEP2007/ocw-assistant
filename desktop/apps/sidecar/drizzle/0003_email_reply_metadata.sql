ALTER TABLE draft_emails ADD COLUMN thread_id TEXT;
ALTER TABLE draft_emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE draft_emails ADD COLUMN references_header TEXT;
