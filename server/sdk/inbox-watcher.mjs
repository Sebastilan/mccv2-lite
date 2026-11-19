// inbox-watcher.mjs — SQLite inbox 500ms 轮询（polling + socket push 兜底）

export class InboxWatcher {
  constructor(db, actorId, onMessage) {
    this._db = db;
    this._actorId = actorId;
    this._onMessage = onMessage;
    this._lastSeenId = 0;
    this._timer = null;
  }

  start(fromId = 0) {
    this._lastSeenId = fromId;
    this._timer = setInterval(() => this._tick(), 500);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const rows = this._db.prepare(
      'SELECT * FROM messages WHERE to_id = ? AND id > ? ORDER BY id ASC'
    ).all(this._actorId, this._lastSeenId);
    for (const row of rows) {
      const id = Number(row.id);
      if (id > this._lastSeenId) this._lastSeenId = id;
      this._onMessage({ ...row, id, payload: JSON.parse(row.payload) });
    }
  }
}
