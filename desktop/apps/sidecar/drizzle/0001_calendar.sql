CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  color TEXT,
  included TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_event_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  status TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  attendees_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(calendar_id) REFERENCES calendars(id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar_id ON calendar_events(calendar_id);
