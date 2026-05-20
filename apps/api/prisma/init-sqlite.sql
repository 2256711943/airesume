PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  selling_points JSON NOT NULL,
  target_audience TEXT NOT NULL,
  platform TEXT NOT NULL,
  tone TEXT NOT NULL,
  banned_terms JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS products_user_id_created_at_idx
ON products(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS products_platform_category_idx
ON products(platform, category);

CREATE TABLE IF NOT EXISTS copy_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS copy_variants (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  variant_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  bullets JSON NOT NULL,
  cta TEXT NOT NULL,
  source_type TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES copy_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS copy_variants_task_id_variant_index_idx
ON copy_variants(task_id, variant_index);

CREATE TABLE IF NOT EXISTS copy_scores (
  id TEXT PRIMARY KEY NOT NULL,
  variant_id TEXT NOT NULL,
  rule_score REAL NOT NULL,
  llm_score REAL NOT NULL,
  overall_score REAL NOT NULL,
  dimensions JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (variant_id) REFERENCES copy_variants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS adoption_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  variant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  adopted INTEGER NOT NULL,
  reason_tags JSON NOT NULL,
  comment TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (variant_id) REFERENCES copy_variants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
