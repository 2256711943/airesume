PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS resume_tasks_user_id_created_at_idx
ON resume_tasks(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS resume_versions (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  variant_index INTEGER NOT NULL,
  summary TEXT NOT NULL,
  experience JSON NOT NULL,
  projects JSON NOT NULL,
  skills JSON NOT NULL,
  source_type TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES resume_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS resume_versions_task_id_variant_index_idx
ON resume_versions(task_id, variant_index);

CREATE TABLE IF NOT EXISTS resume_library_items (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  experience JSON NOT NULL,
  projects JSON NOT NULL,
  skills JSON NOT NULL,
  source_request_id TEXT,
  source_mode TEXT NOT NULL,
  metadata JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS resume_library_items_user_id_created_at_idx
ON resume_library_items(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS resume_variant_selection_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  add_to_library INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  variant_snapshot JSON NOT NULL,
  score_snapshot JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS resume_variant_selection_events_user_id_created_at_idx
ON resume_variant_selection_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS resume_variant_selection_events_request_id_idx
ON resume_variant_selection_events(request_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS conversations_user_id_updated_at_idx
ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  intent TEXT,
  agent_name TEXT,
  tool_call_summary JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_id_created_at_idx
ON conversation_messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_memory_slots (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  slot_value JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_memory_slots_conversation_id_slot_key_key
ON conversation_memory_slots(conversation_id, slot_key);

CREATE INDEX IF NOT EXISTS conversation_memory_slots_conversation_id_updated_at_idx
ON conversation_memory_slots(conversation_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  orchestrator_decision JSON,
  selected_agent TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  latency_ms INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_runs_conversation_id_created_at_idx
ON agent_runs(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_message_id_idx
ON agent_runs(message_id);

CREATE TABLE IF NOT EXISTS tool_call_logs (
  id TEXT PRIMARY KEY NOT NULL,
  agent_run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json JSON NOT NULL,
  output_json JSON,
  success INTEGER NOT NULL,
  latency_ms INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tool_call_logs_agent_run_id_created_at_idx
ON tool_call_logs(agent_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_call_logs_tool_name_created_at_idx
ON tool_call_logs(tool_name, created_at DESC);
