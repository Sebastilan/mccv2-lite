-- schema.sql — mccv2 SQLite 单一源（actors + messages + subs 三表建表语句）

CREATE TABLE IF NOT EXISTS actors (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actors_status ON actors(status, last_seen);

CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id  TEXT    NOT NULL,
  to_id    TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  payload  TEXT    NOT NULL,
  ts       INTEGER NOT NULL,
  reply_to INTEGER,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_inbox  ON messages(to_id, consumed, id);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(reply_to);
-- 进终端拉历史走 (to_id=? OR from_id=?) ORDER BY id：from_id 那一支需要 (from_id,id) 才能有序检索，
-- 否则只能 SCAN（对"全是旧消息的死终端"会扫穿全表）。配合分页 LIMIT 用。
CREATE INDEX IF NOT EXISTS idx_msg_from   ON messages(from_id, id);

CREATE TABLE IF NOT EXISTS subs (
  watcher_id TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  PRIMARY KEY (watcher_id, target_id)
);
