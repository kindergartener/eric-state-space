CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'anonymous',
  url TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
