CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  display_name TEXT,
  current_question_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  telegram_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  mastery REAL NOT NULL DEFAULT 0,
  due_at TEXT,
  last_result TEXT,
  PRIMARY KEY (telegram_id, question_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mini_app_state (
  telegram_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(telegram_id, due_at);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(telegram_id, created_at DESC);
