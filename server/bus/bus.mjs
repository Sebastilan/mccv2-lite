// bus.mjs — SQLite 消息总线包装（actors + messages + subs 三表 CRUD + actor 事件订阅）
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { obs } from '../ops/observability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(__dirname, '../../protocol/schema.sql'), 'utf-8');

export class Bus extends EventEmitter {
  constructor(dbPath) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.broadcaster = null;
  }

  setBroadcaster(b) {
    this.broadcaster = b;
  }

  applyMigrations() {
    this.db.exec(SCHEMA);
  }

  registerActor(id, kind, meta = {}) {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO actors (id, kind, status, meta, created_at, last_seen)
      VALUES (?, ?, 'idle', ?, ?, ?)
    `).run(id, kind, JSON.stringify(meta), now, now);
  }

  updateActor(id, patch) {
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
    values.push(id);
    this.db.prepare(`UPDATE actors SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  insertMessage(msg) {
    const t = Date.now();
    const { from_id, to_id, kind, payload, ts, reply_to = null } = msg;
    const info = this.db.prepare(`
      INSERT INTO messages (from_id, to_id, kind, payload, ts, reply_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(from_id, to_id, kind, JSON.stringify(payload), ts, reply_to);
    obs.counter('messages.inserted');
    obs.hist('insert.ms', Date.now() - t);
    const inserted = {
      id: Number(info.lastInsertRowid),
      from_id, to_id, kind, payload, ts, reply_to,
    };
    if (this.broadcaster) {
      this.broadcaster.onMessage(inserted);
    }
    return inserted;
  }

  markStaleActorsGone(timeoutMs) {
    const cutoff = Date.now() - timeoutMs;
    // Only clean up human (browser WS) actors; cc actors are long-lived and managed by cc-pool
    this.db.prepare(
      `UPDATE actors SET status = 'gone' WHERE status != 'gone' AND kind = 'human' AND last_seen < ?`
    ).run(cutoff);
  }

  addSub(watcherId, targetId) {
    this.db.prepare('INSERT OR IGNORE INTO subs (watcher_id, target_id) VALUES (?, ?)').run(watcherId, targetId);
  }

  removeSub(watcherId, targetId) {
    this.db.prepare('DELETE FROM subs WHERE watcher_id = ? AND target_id = ?').run(watcherId, targetId);
  }

  listSubs(targetId) {
    return this.db.prepare('SELECT watcher_id FROM subs WHERE target_id = ?')
      .all(targetId).map(r => r.watcher_id);
  }

  getNewMessagesSince(sinceId) {
    return this.db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC')
      .all(sinceId)
      .map(row => ({ ...row, id: Number(row.id), payload: JSON.parse(row.payload) }));
  }

  getMaxMessageId() {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) as m FROM messages').get();
    return Number(row.m);
  }
}
