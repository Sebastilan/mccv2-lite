// actor.mjs — Actor SDK 主体（register/send/observe/leave + EventEmitter + 心跳）
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import net from 'net';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { InboxWatcher } from './inbox-watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(__dirname, '../../protocol/schema.sql'), 'utf-8');
const HEARTBEAT_MS = 10_000;

export class Actor extends EventEmitter {
  constructor({ id, kind = 'tool', meta = {} }) {
    super();
    this.id = id;
    this.kind = kind;
    this.meta = meta;
    this._db = null;
    this._socketPath = null;
    this._watcher = null;
    this._heartbeatTimer = null;
  }

  connect({ dbPath, socketPath }) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.exec(SCHEMA);
    this._socketPath = socketPath;
    this._watcher = new InboxWatcher(this._db, this.id, (msg) => {
      this.emit('message', msg);
    });
  }

  register() {
    const now = Date.now();
    this._db.prepare(
      'INSERT OR REPLACE INTO actors (id, kind, status, meta, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(this.id, this.kind, 'idle', JSON.stringify(this.meta), now, now);
    const maxId = Number(
      this._db.prepare('SELECT COALESCE(MAX(id), 0) as m FROM messages').get().m
    );
    this._watcher.start(maxId);
    this._heartbeatTimer = setInterval(() => {
      this._db.prepare('UPDATE actors SET last_seen = ? WHERE id = ?').run(Date.now(), this.id);
    }, HEARTBEAT_MS);
  }

  send(toId, kind, payload) {
    const info = this._db.prepare(
      'INSERT INTO messages (from_id, to_id, kind, payload, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(this.id, toId, kind, JSON.stringify(payload), Date.now());
    const msgId = Number(info.lastInsertRowid);
    this._notify({ event: 'external_notify' });
    return msgId;
  }

  observe(targetId) {
    this._db.prepare(
      'INSERT OR IGNORE INTO subs (watcher_id, target_id) VALUES (?, ?)'
    ).run(this.id, targetId);
  }

  unobserve(targetId) {
    this._db.prepare(
      'DELETE FROM subs WHERE watcher_id = ? AND target_id = ?'
    ).run(this.id, targetId);
  }

  listActors({ kind, status } = {}) {
    let sql = 'SELECT * FROM actors WHERE 1=1';
    const params = [];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY last_seen DESC';
    return this._db.prepare(sql).all(...params).map(r => ({
      ...r, meta: JSON.parse(r.meta),
    }));
  }

  leave() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this._watcher?.stop();
    this._db.prepare(
      "UPDATE actors SET status = 'gone', last_seen = ? WHERE id = ?"
    ).run(Date.now(), this.id);
    this._db.close();
  }

  _notify(data) {
    if (!this._socketPath) return;
    const sock = net.connect(this._socketPath, () => {
      sock.write(JSON.stringify(data) + '\n');
      sock.end();
    });
    sock.on('error', () => {}); // notify 失败 ok，polling 兜底
  }
}
