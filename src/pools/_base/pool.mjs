// pool.mjs — BasePool（actor-stdio v1 通用层）
//
// 任何 actor adapter（adapters/ling/ling.mjs 等）只需作为子进程讲 stdio v1 JSONL
// （详 protocol/actor-stdio-v1.md），本 pool 负责：
//   - 与 core 双向 socket 通信（pool↔core 协议，与 cc-pool 同款）
//   - per-actor 串行 deliverLoop + control 带外
//   - spawn adapter 子进程 + 双向 stdio JSONL（pool↔adapter 协议 = stdio v1）
//   - 5 事件分发到 bus（writeback messages 表 + 通知 core 广播）
//   - busy/idle 状态机 + 累计 cost/tokens + crash 兜底
//
// 与 src/pools/cc/cc-pool.mjs 对照：通用部分一一对应；CC 特异（stream-json 解析 / env 净化 /
// sessionId resume）封在 adapter 子进程里（如 adapters/cc/cc-runner.mjs 未来落地）。

import net from 'net';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';

export const PROTOCOL_VERSION = 1;
export const OPS = ['start', 'deliver', 'stop', 'control'];
export const EVENTS = ['session_init', 'text', 'tool_call', 'reasoning', 'turn_done'];
export const REASONING_SUBTYPES = ['thinking', 'intent'];

export class BasePool {
  /**
   * @param {object} opts
   * @param {string} opts.kind         本 pool 负责的 actor kind（如 'ling'）
   * @param {string} opts.coreSocket   core Unix socket 路径
   * @param {string} opts.dbPath       bus.db 路径
   * @param {object} opts.launcher     adapter 子进程启动规范
   * @param {string} opts.launcher.command   命令路径（如 'node'）
   * @param {string[]} opts.launcher.args    命令参数（如 ['/abs/path/ling.mjs']）
   * @param {object} [opts.launcher.env]     可选 env override（与 process.env 合并）
   * @param {string} [opts.pidFile]    singleton PID 文件路径（防同 kind pool 双开）
   */
  constructor(opts) {
    this.kind = opts.kind;
    this.coreSocket = opts.coreSocket;
    this.dbPath = opts.dbPath;
    this.launcher = opts.launcher;
    this.pidFile = opts.pidFile || null;
    this.db = null;
    this.coreConn = null;
    this.coreLineBuf = '';
    // Map<actorId, { child, state, delivering, _resultResolve, turnUsage, turnTools }>
    this.children = new Map();
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────
  start() {
    // singleton guard
    if (this.pidFile) {
      if (existsSync(this.pidFile)) {
        const existingPid = parseInt(readFileSync(this.pidFile, 'utf-8').trim());
        if (existingPid && existingPid !== process.pid) {
          try { process.kill(existingPid, 0); return false; } catch { /* stale */ }
        }
      }
      writeFileSync(this.pidFile, String(process.pid));
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    // startup reset: pool 死时残留 busy 的同 kind actor 全部回 idle
    const reset = this.db.prepare(
      "UPDATE actors SET status='idle', last_seen=? WHERE kind=? AND status='busy'"
    ).run(Date.now(), this.kind);

    // 装载已有 actor entries（child 字段先空，按需 lazy spawn）
    const existing = this.db.prepare(
      "SELECT * FROM actors WHERE kind=? AND status!='gone'"
    ).all(this.kind);
    for (const row of existing) {
      const meta = JSON.parse(row.meta || '{}');
      this.children.set(row.id, this._makeEntry(row.id, meta));
      if (reset.changes > 0) {
        // 给被恢复的 actor 发 interrupted turn_done，UI 摘掉转圈
        const lastUserMsg = this.db.prepare(
          "SELECT from_id FROM messages WHERE to_id=? AND kind='user_msg' ORDER BY id DESC LIMIT 1"
        ).get(row.id);
        if (lastUserMsg?.from_id) {
          this._insertMessage(row.id, lastUserMsg.from_id, 'event', {
            event_type: 'turn_done', interrupted: true, reason: 'pool restart',
          });
        }
        this.sendToCore({ event: 'actor_status', actorId: row.id, status: 'idle' });
      }
    }

    this._connectToCore();
    return true;
  }

  stop() {
    this._stopped = true;
    for (const [, entry] of this.children) {
      try { entry.child?.kill('SIGTERM'); } catch {}
    }
    this.children.clear();
    try { this.coreConn?.end(); } catch {}
    try { this.db?.close(); } catch {}
  }

  // ── core 连接（pool↔core 协议，与 cc-pool 同款）──────────────────────────
  _connectToCore() {
    const conn = net.createConnection(this.coreSocket);
    conn.on('connect', () => {
      this.coreConn = conn;
      conn.write(JSON.stringify({ event: 'register_pool', kind: this.kind }) + '\n');
    });
    conn.on('data', (data) => {
      this.coreLineBuf += data.toString();
      let nl;
      while ((nl = this.coreLineBuf.indexOf('\n')) !== -1) {
        const line = this.coreLineBuf.slice(0, nl).trim();
        this.coreLineBuf = this.coreLineBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this._handleCoreMsg(msg);
      }
    });
    conn.on('close', () => {
      if (this.coreConn === conn) this.coreConn = null;
      setTimeout(() => this._connectToCore(), 2000);
    });
    conn.on('error', () => { /* suppress */ });
  }

  sendToCore(msg) {
    if (this.coreConn && !this.coreConn.destroyed) {
      this.coreConn.write(JSON.stringify(msg) + '\n');
    }
  }

  _handleCoreMsg(msg) {
    switch (msg.event) {
      case 'new_message': this.handleNewMessage(msg.actorId); break;
      case 'new_actor':   this.handleNewActor(msg.actor); break;
      case 'stop_actor':  this.handleStopActor(msg.actorId); break;
    }
  }

  // ── 4 动词处理（core → pool）─────────────────────────────────────────────
  handleNewMessage(actorId) {
    this._ensureEntry(actorId);
    this._drainControls(actorId);
    this._deliverLoop(actorId);
  }

  handleNewActor(actor) {
    if (actor.kind !== this.kind) return;
    if (!this.children.has(actor.id)) {
      const meta = JSON.parse(actor.meta || '{}');
      this.children.set(actor.id, this._makeEntry(actor.id, meta));
    }
    this._deliverLoop(actor.id);
  }

  handleStopActor(actorId) {
    const entry = this.children.get(actorId);
    if (entry?.child) {
      try { entry.child.kill('SIGTERM'); } catch {}
    }
    this.children.delete(actorId);
    this.db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?")
      .run(Date.now(), actorId);
    this.db.prepare("UPDATE messages SET consumed=1 WHERE to_id=? AND consumed=0").run(actorId);
  }

  _makeEntry(actorId, meta) {
    return {
      actorId, meta,
      child: null,
      lastFrom: null,
      sessionId: meta.sessionId || null,
      sessionModel: meta.sessionModel || null,
      delivering: false,
      _resultResolve: null,
      turnTools: {}, turnUsage: { input_tokens: 0, output_tokens: 0 },
      currentMsgId: null,
    };
  }

  _ensureEntry(actorId) {
    if (this.children.has(actorId)) return;
    const row = this.db.prepare(
      "SELECT * FROM actors WHERE id=? AND kind=? AND status!='gone'"
    ).get(actorId, this.kind);
    if (!row) return;
    const meta = JSON.parse(row.meta || '{}');
    this.children.set(actorId, this._makeEntry(actorId, meta));
  }

  // ── control 走带外（不被 deliverLoop 锁住）──────────────────────────────
  //
  // 线形有两种历史形状：UI slash 菜单发 { command, ... }，/api/actors/:id/interrupt 发
  // { action:'interrupt' }。两个字段都认，别再让 control 静默掉地上。
  _drainControls(actorId) {
    const entry = this.children.get(actorId);
    if (!entry) return;
    while (true) {
      const msg = this.db.prepare(
        "SELECT * FROM messages WHERE to_id=? AND consumed=0 AND kind='control' ORDER BY id ASC LIMIT 1"
      ).get(actorId);
      if (!msg) break;
      this.db.prepare('UPDATE messages SET consumed=1 WHERE id=?').run(msg.id);
      const payload = (() => { try { return JSON.parse(msg.payload); } catch { return {}; } })();
      try {
        this._handleControl(actorId, entry, msg.from_id, payload.command || payload.action, payload);
      } catch (e) {
        console.error(`[${this.kind}-pool] control ${payload.command || payload.action} failed:`, e?.message);
      }
    }
  }

  /**
   * 处理一条 control。语义对齐 src/pools/cc/controls.mjs，只实现 stdio v1 能表达的部分。
   * 未知命令如实回一句，不静默——静默是上一版"切模型没反应"的根因。
   */
  _handleControl(actorId, entry, fromId, cmd, payload = {}) {
    if (!cmd) return;
    const child = entry.child;
    const alive = child && child.exitCode === null && child.signalCode === null;
    const writable = alive && child.stdin?.writable;
    const isBusy = this.db.prepare('SELECT status FROM actors WHERE id=?').get(actorId)?.status === 'busy';
    const reply = (text) => this._insertMessage(actorId, fromId, 'text', { text });
    const readMeta = () => {
      const row = this.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
      try { return JSON.parse(row?.meta || '{}'); } catch { return {}; }
    };
    const writeMeta = (meta) => {
      this.db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);
      entry.meta = meta;   // 内存 entry 同步，否则下次 spawn 的 start op 还带旧 meta
      this.sendToCore({ event: 'actor_updated', actorId });
    };

    switch (cmd) {
      case 'interrupt':
        if (writable) child.stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, op: 'control', kind: 'interrupt' }) + '\n');
        return;

      case 'model': {
        const model = payload.model;
        if (!model) return;
        if (isBusy) { reply('⚠️ 正在跑，请等空闲后再切模型'); return; }
        const meta = readMeta();
        meta.model = model;
        delete meta.sessionModel;   // 展示字段，下轮 session_init 回写真实值
        writeMeta(meta);
        entry.sessionModel = null;
        // 活着的 adapter 热切（不杀进程、不动会话历史）；没活着则下次 spawn 的 start op 带新 model
        if (writable) child.stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, op: 'control', kind: 'model', model }) + '\n');
        reply(`🔄 已切换到 ${model}（对话保留）`);
        return;
      }

      case 'clear': {
        if (isBusy) { reply('⚠️ 正在跑，请等空闲后再重置会话'); return; }
        if (alive) { try { child.kill('SIGTERM'); } catch { /* 已退 */ } }
        const meta = readMeta();
        delete meta.sessionId;
        delete meta.sessionModel;
        writeMeta(meta);
        entry.sessionId = null;
        entry.sessionModel = null;
        reply('🗑 会话已重置');
        return;
      }

      case 'status': {
        const meta = readMeta();
        const status = this.db.prepare('SELECT status FROM actors WHERE id=?').get(actorId)?.status || 'unknown';
        reply(`📊 ${status} · ${meta.sessionModel || meta.model || '?'} · 累计 $${(meta.totalCost || 0).toFixed(4)}`);
        return;
      }

      case 'cost': {
        const meta = readMeta();
        const ctxTok = meta.lastUsage?.input_tokens;
        reply(`💰 累计 $${(meta.totalCost || 0).toFixed(4)} · 当前上下文 ${ctxTok != null ? ctxTok + ' tok' : '—'}`);
        return;
      }

      default:
        reply(`⚠️ ${this.kind} 终端暂不支持 /${cmd}`);
    }
  }

  // ── per-actor 串行 deliver 循环 ──────────────────────────────────────────
  async _deliverLoop(actorId) {
    if (!this.children.has(actorId) || this.children.get(actorId).delivering) return;
    this.children.get(actorId).delivering = true;

    while (true) {
      if (!this.children.has(actorId)) return;
      const entry = this.children.get(actorId);
      const msg = this.db.prepare(
        "SELECT * FROM messages WHERE to_id=? AND consumed=0 AND kind IN ('user_msg','text') ORDER BY id ASC LIMIT 1"
      ).get(actorId);
      if (!msg) break;
      this.db.prepare('UPDATE messages SET consumed=1 WHERE id=?').run(msg.id);
      await this._deliverOne(actorId, entry, msg);
    }

    const e = this.children.get(actorId);
    if (e) e.delivering = false;
  }

  async _deliverOne(actorId, entry, msg) {
    const payload = (() => { try { return JSON.parse(msg.payload); } catch { return {}; } })();

    // 信件 vs 会话流分离（同 cc-pool）
    if (payload?.meta?.expectAutoReply !== false) {
      entry.lastFrom = msg.from_id;
    }

    this.db.prepare("UPDATE actors SET status='busy', last_seen=? WHERE id=?")
      .run(Date.now(), actorId);
    this.sendToCore({ event: 'actor_status', actorId, status: 'busy' });

    const childDead = !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null;
    if (childDead) {
      await this._spawnAdapter(actorId, entry);
    }

    entry.turnTools = {};
    entry.turnUsage = { input_tokens: 0, output_tokens: 0 };
    entry.currentMsgId = msg.id;
    // msg_started 让前端摘掉"排队中"标记
    this._insertMessage(actorId, msg.from_id, 'event', { event_type: 'msg_started', msg_id: msg.id });

    // 发 stdio v1 deliver op
    entry.child.stdin.write(JSON.stringify({
      v: PROTOCOL_VERSION,
      op: 'deliver',
      msg_id: msg.id,
      text: payload?.text || '',
      attachments: payload?.attachments || [],
    }) + '\n');

    // 等 turn_done
    await new Promise((resolve) => { entry._resultResolve = resolve; });
  }

  // ── 起 adapter 子进程并接 stdio v1 ────────────────────────────────────────
  async _spawnAdapter(actorId, entry) {
    const env = { ...process.env, ...(this.launcher.env || {}) };
    const child = spawn(this.launcher.command, this.launcher.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    entry.child = child;

    child.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) this.sendToCore({ event: 'pool_trace', type: 'adapter.stderr', actor: actorId, line });
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.v !== PROTOCOL_VERSION || !ev.ev) return;
      this._handleAdapterEvent(actorId, entry, ev);
    });

    child.on('exit', (code, signal) => {
      if (this._stopped) return;  // pool 已 shutdown，跳过兜底（DB 已关）
      // 异常退出兜底：actor 仍 busy 则强制 idle + 发 interrupted turn_done
      const row = this.db.prepare("SELECT status FROM actors WHERE id=?").get(actorId);
      if (row?.status === 'busy') {
        this.db.prepare("UPDATE actors SET status='idle', last_seen=? WHERE id=?")
          .run(Date.now(), actorId);
        this.sendToCore({ event: 'actor_status', actorId, status: 'idle' });
        if (entry.lastFrom) {
          this._insertMessage(actorId, entry.lastFrom, 'event', {
            event_type: 'turn_done', interrupted: true,
            reason: signal ? `signal:${signal}` : `code:${code}`,
            msg_id: entry.currentMsgId,
          });
        }
      }
      if (entry._resultResolve) { entry._resultResolve(); entry._resultResolve = null; }
      if (code !== 0 || signal) {
        this.sendToCore({ event: 'pool_trace', type: 'adapter.crashed', actor: actorId, code, signal });
      }
    });

    // 发 start op
    child.stdin.write(JSON.stringify({
      v: PROTOCOL_VERSION,
      op: 'start',
      actor_id: actorId,
      meta: entry.meta,
    }) + '\n');
  }

  // ── 5 事件分发（adapter → pool）───────────────────────────────────────────
  _handleAdapterEvent(actorId, entry, ev) {
    switch (ev.ev) {
      case 'session_init':
        if (ev.session_id) entry.sessionId = ev.session_id;
        if (ev.model) entry.sessionModel = ev.model;
        this._persistSession(actorId, entry, ev.capabilities);
        this.sendToCore({ event: 'actor_updated', actorId });
        break;
      case 'text':
        this.emitText(actorId, entry, ev.text || '');
        break;
      case 'tool_call':
        this.emitToolCall(actorId, entry, ev);
        break;
      case 'reasoning':
        this.emitReasoning(actorId, entry, ev);
        break;
      case 'turn_done':
        this.emitTurnDone(actorId, entry, ev);
        break;
    }
  }

  emitText(actorId, entry, text) {
    if (!entry.lastFrom) return;
    this._insertMessage(actorId, entry.lastFrom, 'text', { text });
  }

  emitToolCall(actorId, entry, ev) {
    if (!entry.lastFrom) return;
    this._insertMessage(actorId, entry.lastFrom, 'tool_call', {
      id: ev.id, name: ev.name, input: ev.input, result_summary: ev.result_summary,
    });
    entry.turnTools[ev.name] = (entry.turnTools[ev.name] || 0) + 1;
    this._persistLastTool(actorId, ev.name);
  }

  emitReasoning(actorId, entry, ev) {
    if (!entry.lastFrom) return;
    this._insertMessage(actorId, entry.lastFrom, 'event', {
      event_type: 'reasoning', subtype: ev.subtype, text: ev.text,
    });
  }

  emitTurnDone(actorId, entry, ev) {
    this.db.prepare("UPDATE actors SET status='idle', last_seen=? WHERE id=?")
      .run(Date.now(), actorId);
    this.sendToCore({ event: 'actor_status', actorId, status: 'idle' });

    // 累计 cost/tokens 进 actor.meta
    const row = this.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
    const meta = row ? JSON.parse(row.meta || '{}') : {};
    if (ev.cost_usd != null) meta.totalCost = (meta.totalCost || 0) + (ev.cost_usd || 0);
    if (ev.usage) {
      const tokTotal = (ev.usage.input_tokens || 0) + (ev.usage.output_tokens || 0);
      if (tokTotal) meta.totalTokens = (meta.totalTokens || 0) + tokTotal;
    }
    if (ev.tools) meta.lastTool = Object.keys(ev.tools).pop() || meta.lastTool;
    // context_usage = 末次 API call 的输入构成（当前上下文占用，非本轮累计）→ 前端 ctx 徽章
    if (ev.context_usage) meta.lastUsage = ev.context_usage;
    this.db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);

    if (entry.lastFrom) {
      this._insertMessage(actorId, entry.lastFrom, 'event', {
        event_type: 'turn_done',
        msg_id: ev.msg_id || entry.currentMsgId,
        cost_usd: ev.cost_usd,
        usage: ev.usage,
        tools: ev.tools,
        stop_reason: ev.stop_reason,
        interrupted: ev.interrupted || false,
      });
    }
    this.sendToCore({ event: 'actor_updated', actorId });
    if (entry._resultResolve) { entry._resultResolve(); entry._resultResolve = null; }
  }

  // ── 工具：DB 写消息 + 通知 core 广播 ─────────────────────────────────────
  _insertMessage(fromId, toId, kind, payload) {
    this.db.prepare('INSERT INTO messages (from_id, to_id, kind, payload, ts) VALUES (?,?,?,?,?)')
      .run(fromId, toId, kind, JSON.stringify(payload), Date.now());
    this.sendToCore({ event: 'new_message' });
  }

  _persistSession(actorId, entry, capabilities) {
    const row = this.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
    if (!row) return;
    const meta = JSON.parse(row.meta || '{}');
    if (entry.sessionId) meta.sessionId = entry.sessionId;
    if (entry.sessionModel) meta.sessionModel = entry.sessionModel;
    if (capabilities) meta.capabilities = capabilities;
    this.db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);
    // 关键:同步回写内存 entry.meta —— 否则同进程重拉时 start 命令带的 entry.meta 仍无 sessionId,
    // adapter 会走 Date.now() 兜底另开新会话文件 → 丢掉此前全部历史(重启失忆根因)。
    if (entry.meta) {
      if (entry.sessionId) entry.meta.sessionId = entry.sessionId;
      if (entry.sessionModel) entry.meta.sessionModel = entry.sessionModel;
      if (capabilities) entry.meta.capabilities = capabilities;
    }
  }

  _persistLastTool(actorId, toolName) {
    const row = this.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
    if (!row) return;
    const meta = JSON.parse(row.meta || '{}');
    meta.lastTool = toolName;
    this.db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);
  }
}
