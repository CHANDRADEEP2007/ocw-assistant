CREATE TABLE IF NOT EXISTS orchestration_runs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  error_details TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  intent_guess TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES orchestration_runs(id)
);

CREATE TABLE IF NOT EXISTS execution_plans (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES orchestration_runs(id)
);

CREATE TABLE IF NOT EXISTS judge_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  requires_approval TEXT NOT NULL,
  required_fields_json TEXT NOT NULL,
  policy_notes_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES orchestration_runs(id)
);

CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES orchestration_runs(id)
);

CREATE TABLE IF NOT EXISTS tool_execution_logs (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  args_json TEXT,
  result_json TEXT,
  error_details TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES orchestration_runs(id)
);

