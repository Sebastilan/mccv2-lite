// cc-pool.mjs — CC pool 进程入口（管理 Map<actorId, child>，双向核心 socket 通信）
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { CCState } from './state.mjs';
import { spawnCC, closeCaptureProxy } from './process.mjs';
import { spawnPtyCC, usePtyDriver } from './process-pty.mjs';
import { writeUserFrame } from './stdin.mjs';
import { saveAttachmentsToInbox } from './inbox.mjs';
import { handleControl } from './controls.mjs';
import { readStdout } from './stdout.mjs';
import { collectContextUsage } from './context-usage.mjs';
import { parseAndExtractShares } from '../../share.mjs';
import { wrapDeliveryText } from '../../actor-bus/message-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const coreSocketIdx = argv.indexOf('--core-socket');
const coreSocket = coreSocketIdx !== -1 ? argv[coreSocketIdx + 1] : null;

if (!coreSocket) {
  console.error('[cc-pool] Usage: node cc-pool.mjs --core-socket <path>');
  process.exit(1);
}

// Singleton guard: only one cc-pool per core socket directory
// CC_POOL_PID env 覆盖仅供隔离测试(判分器起独立 cc-pool,不撞生产单例守卫);默认不变。
const PID_FILE = process.env.CC_POOL_PID || path.join(ROOT, 'sockets', 'cc-pool.pid');
if (existsSync(PID_FILE)) {
  const existingPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
  if (existingPid && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 0);  // throws if dead
      console.log(`[cc-pool] another cc-pool (pid=${existingPid}) is running, exiting`);
      process.exit(0);
    } catch {
      // Stale PID file — previous cc-pool is dead, proceed
    }
  }
}
writeFileSync(PID_FILE, String(process.pid));

// ── SQLite ────────────────────────────────────────────────────────────────────
// CC_POOL_DB env 覆盖仅供隔离测试(判分器指向临时 DB,绝不碰生产 data/bus.db);默认不变。
const DB_PATH = process.env.CC_POOL_DB || path.join(ROOT, 'data', 'bus.db');
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');   // spawn 风暴时给 C 层更多退避头寸(10s),配 safeRun catch+drop 兜底
} catch (e) {
  console.error('[cc-pool] failed to open DB:', e.message);
  process.exit(1);
}

// ── SQLite 写锁争用兜底 ─────────────────────────────────────────────────────────
// 背景:高并发(多终端 spawn/resume)时大家挤着写同一个 bus.db,SQLite 单写锁被某连接
// 占用超过 busy_timeout,后续写抛 `SqliteError: database is locked` / SQLITE_BUSY。
// 这类是**可重试的瞬时锁错**,不该被当致命错处死整个 pool。判别 + catch+drop 单条即可。

// 纯函数:判定一个错误是否是"可恢复的写锁争用"(SQLITE_BUSY / database is locked)。
// 便于单测,不依赖任何外部状态。
function isRecoverableDbError(err) {
  if (!err) return false;
  if (err.code === 'SQLITE_BUSY') return true;
  return /database is locked/i.test(err.message || '');
}

// 安全写包装:正常写返回 stmt.run 结果;遇到可恢复锁错 → WARN 记一条后丢弃(return null,不抛);
// 其他错(真致命,如 schema 错/约束违反) → 继续 throw,维持原行为与可观测性。
// 注意:busy_timeout 已在 C 层同步阻塞重试到 10s,这里**绝不**再做 JS 层 busy-wait 重试
// (会冻住整个 pool 事件循环),只做 catch+drop。
function safeRun(stmt, ...args) {
  try {
    return stmt.run(...args);
  } catch (err) {
    if (isRecoverableDbError(err)) {
      console.warn('[cc-pool] db write dropped (busy):', err.message);
      return null;
    }
    throw err;
  }
}

// ── Actor registry ────────────────────────────────────────────────────────────
// Map<actorId, { child, state, delivering, _resultResolve }>
const children = new Map();

// ── Core socket connection ────────────────────────────────────────────────────
let coreConn = null;
let coreLineBuf = '';

function sendToCore(msg) {
  if (coreConn && !coreConn.destroyed) {
    coreConn.write(JSON.stringify(msg) + '\n');
  }
}

function connectToCore() {
  const conn = net.createConnection(coreSocket);

  conn.on('connect', () => {
    coreConn = conn;
    console.log('[cc-pool] connected to core socket');
    conn.write(JSON.stringify({ event: 'register_pool', kind: 'cc' }) + '\n');
    // 重连补扫(自愈丢弃的 new_message 通知):cc-pool 断线期间 core 投来的通知会被
    // pool-registry.send() 直接丢(socket 不通),且重连后无人补发——若目标 actor 此时
    // idle,该消息会永久躺库不投递。这里每次(重)连上后主动扫一遍未消费 user_msg/text,
    // 唤醒对应 deliverLoop。亦覆盖冷启动时已积压消息的首投。deliverLoop 幂等(delivering 闸)。
    drainPending();
  });

  conn.on('data', (data) => {
    coreLineBuf += data.toString();
    let nl;
    while ((nl = coreLineBuf.indexOf('\n')) !== -1) {
      const line = coreLineBuf.slice(0, nl).trim();
      coreLineBuf = coreLineBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleCoreMsg(msg);
    }
  });

  conn.on('close', () => {
    if (coreConn === conn) coreConn = null;
    console.log('[cc-pool] disconnected from core, retry in 2s');
    setTimeout(connectToCore, 2000);
  });

  conn.on('error', (err) => {
    // Suppress expected errors during core restart
    if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') {
      console.error('[cc-pool] core socket error:', err.message);
    }
  });
}

// ── Core message handler ──────────────────────────────────────────────────────
function handleCoreMsg(msg) {
  switch (msg.event) {
    case 'new_message': {
      ensureEntry(msg.actorId);
      // control 消息出走带外：interrupt 必须在 busy 时立即生效，不能被 deliverLoop 锁住
      drainControls(msg.actorId);
      deliverLoop(msg.actorId);
      break;
    }
    case 'new_actor': {
      const actor = msg.actor;
      if (!children.has(actor.id)) {
        const meta = JSON.parse(actor.meta || '{}');
        children.set(actor.id, makeEntry(actor.id, meta));
      }
      deliverLoop(actor.id);
      break;
    }
    case 'stop_actor': {
      const { actorId } = msg;
      const entry = children.get(actorId);
      if (entry?.child) {
        // SIGTERM 真杀子进程（stdin.end 只发 EOF，正在 turn 中的子进程要跑完才退，
        // 期间 deliverLoop 还在 await，会继续 respawn 新子进程——2026-05-23 死循环事故根因之一）
        try { entry.child.kill('SIGTERM'); } catch {}
      }
      if (entry?.state) closeCaptureProxy(entry.state);   // 释放 per-actor 抓包代理(关 http server)
      children.delete(actorId);
      safeRun(db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?"),
        Date.now(), actorId);
      // 丢弃所有未消费的待办消息，防止 deliverLoop 醒来后继续灌
      safeRun(db.prepare("UPDATE messages SET consumed=1 WHERE to_id=? AND consumed=0"), actorId);
      console.log(`[cc-pool] stopped actor ${actorId}`);
      break;
    }
  }
}

function makeEntry(actorId, meta) {
  return { child: null, state: new CCState(actorId, meta), delivering: false, _resultResolve: null };
}

// spawn 失败统一隔离：无论 child 异步 emit 'error'（cwd/bin ENOENT），还是
// spawnCC/spawnPtyCC 函数体同步抛（配置/代码错），都收敛到这里，只影响单 actor，
// 绝不冒泡成 pool 级 uncaughtException/unhandledRejection 打挂整个 cc-pool。
function handleSpawnFailure(actorId, state, err) {
  const msg = err?.message || String(err);
  console.error(`[cc:${actorId}] spawn error:`, msg);
  sendToCore({ event: 'pool_trace', type: 'cc.spawn_error', actor: actorId, line: msg });
  sendToCore({ event: 'pool_counter', name: 'cc.crashes', n: 1 });
  state.setStopped();
  // 永久失败：项目目录(cwd)被删/改名 → 归档 gone，不无限重试一个起不来的终端。
  const cwd = state.meta?.projectPath;
  if (cwd && !existsSync(cwd)) {
    closeCaptureProxy(state);   // 归档前释放 per-actor 抓包代理
    safeRun(db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?"), Date.now(), actorId);
    sendToCore({ event: 'actor_status', actorId, status: 'gone' });
    console.error(`[cc:${actorId}] projectPath 不存在(${cwd})，actor 已归档为 gone`);
    return;
  }
  const row = db.prepare("SELECT status FROM actors WHERE id=?").get(actorId);
  if (row?.status === 'busy') {
    safeRun(db.prepare("UPDATE actors SET status='idle', last_seen=? WHERE id=?"), Date.now(), actorId);
    sendToCore({ event: 'actor_status', actorId, status: 'idle' });
  }
}

// Spawn CC child + 接上 stderr/stdout/exit 三路监听。deliverOne respawn 用。
// async:原生路 spawnCC 要先备好 per-actor 抓包代理(异步 listen)再 spawn;PTY 路同步、await 透明。
async function attachChild(actorId, entry) {
  const { state } = entry;
  // 驱动选路：pty = tmux 交互式（订阅额度，6/15 备灾线路），默认 print。
  // PtyChild duck-type ChildProcess 被用表面，下面三路监听 + controls 全部无差别工作。
  try {
    entry.child = usePtyDriver(state.meta) ? spawnPtyCC(state) : await spawnCC(state);
  } catch (err) {
    // 同步抛：child 还没造出来，下面的 'error' 监听兜不住，必须在这里隔离。
    handleSpawnFailure(actorId, state, err);
    return;
  }

  entry.child.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      sendToCore({ event: 'pool_trace', type: 'cc.stderr', actor: actorId, line });
      console.error(`[cc:${actorId}] stderr:`, line);
    }
  });

  readStdout(entry.child.stdout, (event) => handleChildEvent(actorId, entry, event));

  // spawn 失败兜底（异步路径）：child 造出来后 emit 'error'（cwd/bin ENOENT 等）。
  // 同步路径（spawn 函数体抛）已由上面 try/catch 兜。两路都收敛到 handleSpawnFailure。
  entry.child.on('error', (err) => handleSpawnFailure(actorId, state, err));

  entry.child.on('exit', (code, signal) => {
    state.setStopped();
    const reaped = entry.reaping === true;   // 计划内 idle 回收，不是崩溃，别污染 crash 指标
    entry.reaping = false;
    if (!reaped && (code !== 0 || signal)) {
      sendToCore({ event: 'pool_trace', type: 'cc.crashed', actor: actorId, code, signal });
      sendToCore({ event: 'pool_counter', name: 'cc.crashes', n: 1 });
    }
    // 异常退出兜底：若 actor 仍 busy（result event 未到就死了），强制设 idle 并发提示
    const row = db.prepare("SELECT status FROM actors WHERE id=?").get(actorId);
    if (row?.status === 'busy') {
      safeRun(db.prepare("UPDATE actors SET status='idle', last_seen=? WHERE id=?"), Date.now(), actorId);
      sendToCore({ event: 'actor_status', actorId, status: 'idle' });
      emitMsg(actorId, state.getLastFrom(), 'event', {
        event_type: 'turn_done',
        interrupted: true,
        reason: signal ? `signal:${signal}` : `code:${code}`,
      });
    }
    if (entry._resultResolve) {
      entry._resultResolve();
      entry._resultResolve = null;
    }
    console.log(`[cc-pool] child ${actorId} exited code=${code} signal=${signal}`);
  });
}

// ── Idle 子进程回收 ───────────────────────────────────────────────────────────
// claude CLI 在 stream-json 模式下一轮结束【不退出】（stdin 保持打开等下一帧），
// 而全仓只有 stop_actor / resetSession / 切换模型 会杀子进程，没有任何按闲置回收的
// 机制 —— 于是一个 idle 终端连同它那套 MCP 子进程永久常驻 400~900MB。
//
// 这里周期扫库，把静默超时的 idle 子进程杀掉。**只杀进程**：actor 本身、sessionId、
// 消息历史、面板卡片全都留着，终端照常能继续聊 —— 下次发消息时 deliverOne 的
// childDead 分支会带 --resume <sessionId> 冷启续接。这和「切换模型」走的是同一条
// 已在生产验证的路径（controls.mjs killChild → 提示"对话保留"），语义安全。
//
// TTL 取 60min 的依据：prompt cache 最长 1h，静默超过 1h 的终端缓存本就已失效，
// 下次发消息无论如何都要重读全量上下文 —— 所以回收不额外增加 token 成本，
// 只付一次冷启动（claude + MCP server 起来的几秒）。
const IDLE_CHILD_TTL_MS = Number(process.env.CC_IDLE_CHILD_TTL_MS || 60 * 60 * 1000);
const IDLE_SWEEP_MS = Number(process.env.CC_IDLE_SWEEP_MS || 5 * 60 * 1000);

function sweepIdleChildren() {
  const cutoff = Date.now() - IDLE_CHILD_TTL_MS;
  for (const [actorId, entry] of children) {
    if (!entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
    if (entry.delivering) continue;                        // 正在投递，别碰
    const row = db.prepare('SELECT status, last_seen FROM actors WHERE id=?').get(actorId);
    if (!row || row.status !== 'idle') continue;           // busy / gone 一律不动
    if (!row.last_seen || row.last_seen > cutoff) continue;
    entry.reaping = true;
    try { entry.child.kill('SIGTERM'); } catch {}
    const mins = Math.round((Date.now() - row.last_seen) / 60000);
    console.log(`[cc-pool] reaped idle child actor=${actorId} silent=${mins}min (会话保留，下次发消息 --resume 续接)`);
    sendToCore({ event: 'pool_counter', name: 'cc.idle_reaped', n: 1 });
  }
}

function ensureEntry(actorId) {
  if (children.has(actorId)) return;
  const row = db.prepare("SELECT * FROM actors WHERE id=? AND kind='cc' AND status!='gone'").get(actorId);
  if (!row) return;
  const meta = JSON.parse(row.meta || '{}');
  children.set(actorId, makeEntry(actorId, meta));
}

// ── Control drain (out-of-band) ──────────────────────────────────────────────
// kind='control' 走独立路径：不进 deliverLoop 串行锁，子进程 busy 时也能立即处理。
function drainControls(actorId) {
  const entry = children.get(actorId);
  if (!entry) return;
  const ctx = { actorId, entry, db, emitMsg, sendToCore };
  while (true) {
    const msg = db.prepare(
      "SELECT * FROM messages WHERE to_id=? AND consumed=0 AND kind='control' ORDER BY id ASC LIMIT 1"
    ).get(actorId);
    if (!msg) break;
    safeRun(db.prepare('UPDATE messages SET consumed=1 WHERE id=?'), msg.id);
    try {
      handleControl(ctx, msg.from_id, JSON.parse(msg.payload));
    } catch (e) {
      console.error(`[cc-pool] control ${msg.id} failed:`, e?.stack || e);
    }
  }
}

// 补扫:所有有未消费 user_msg/text 的存活 cc actor，唤醒其 deliverLoop。
// 连上 core 时调用——把断线窗口里被 pool-registry.send 丢弃的 new_message 通知补回来。
function drainPending() {
  const rows = db.prepare(
    `SELECT DISTINCT to_id FROM messages
       WHERE consumed=0 AND kind IN ('user_msg','text')
         AND to_id IN (SELECT id FROM actors WHERE kind='cc' AND status!='gone')`
  ).all();
  for (const { to_id } of rows) {
    ensureEntry(to_id);
    drainControls(to_id);
    deliverLoop(to_id);
  }
}

// ── Deliver loop (per-actor sequential, 只投喂 CC 真正会 turn 的消息) ────────
// 只 user_msg / text 真正喂给 CC 子进程（writeUserFrame → stdin）；event 是协议层信号
// （worker_done / msg_started / turn_done / tool_purpose 等），喂给 CC 等于灌空消息，
// 会引发两台 CC 互相"待命中"死循环（2026-05-23 事故根因）。control 走带外。
async function deliverLoop(actorId) {
  if (!children.has(actorId) || children.get(actorId).delivering) return;
  children.get(actorId).delivering = true;

  while (true) {
    // 每轮重新查 children——stop_actor 之后必须立刻跳出（旧实现闭包持有死 entry，
    // 删除 actor 后继续 respawn 子进程，叠加 event-as-input 共同制造死循环）
    if (!children.has(actorId)) return;
    const entry = children.get(actorId);
    const msg = db.prepare(
      "SELECT * FROM messages WHERE to_id=? AND consumed=0 AND kind IN ('user_msg','text') ORDER BY id ASC LIMIT 1"
    ).get(actorId);
    if (!msg) break;

    safeRun(db.prepare('UPDATE messages SET consumed=1 WHERE id=?'), msg.id);
    await deliverOne(actorId, entry, msg);
  }

  const e = children.get(actorId);
  if (e) e.delivering = false;
}

async function deliverOne(actorId, entry, msg) {
  const { state } = entry;

  const payload = (() => { try { return JSON.parse(msg.payload); } catch { return {}; } })();

  // 信件 vs 会话流分离（方案 D，2026-05-26）：
  // - 会话流（默认 expectAutoReply=true）：用户/advisor↔worker 的对话，setLastFrom 让 text 输出
  //   自动路由回发起方
  // - 信件（expectAutoReply=false）：actor-bus 主动投递，不预设自动回信路由 → 收件人 text 输出
  //   仍流向"原对话对象"（lastFrom 不变），避免 actor↔actor 自动回信形成死循环。
  //   要回信必须显式 mcp__actor__send_message。详见 docs/actor-bus.md
  if (payload?.meta?.expectAutoReply !== false) {
    state.setLastFrom(msg.from_id);
  }

  // busy 立即标记（spawn 之前），UI 不感知冷启动延迟
  safeRun(db.prepare("UPDATE actors SET status='busy', last_seen=? WHERE id=?"), Date.now(), actorId);
  sendToCore({ event: 'actor_status', actorId, status: 'busy' });

  // Respawn if child has exited (CC --print mode self-exits after each turn).
  // exitCode 为 null 但 signalCode 非 null 表示被信号杀掉，进程同样已死，必须 respawn。
  const childDead = !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null;
  if (childDead) {
    await attachChild(actorId, entry);
  }

  // 新一轮开始：重置 turn-scoped 计数（工具用量 + 本轮 token 累计，turn_done 时回传）
  entry.turnTools = {};
  entry.turnUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  entry.firstLoopUsage = null;
  entry.contextStreamUsage = null;
  // 通知前端：这条排队消息开始被处理（前端按 msg_id 摘掉"排队中"标记）
  emitMsg(actorId, msg.from_id, 'event', { event_type: 'msg_started', msg_id: msg.id });

  let text = wrapDeliveryText({
    db,
    fromId: msg.from_id,
    text: payload?.text || '',
    mentions: payload?.meta?.mentions,
  });
  const attachments = payload?.attachments || [];
  const inboxPaths = saveAttachmentsToInbox(actorId, msg.id, attachments);
  if (inboxPaths.length) {
    text += `\n\n[附件已落地（48h TTL，可用 Read 直接打开）]\n${inboxPaths.map(p => '  ' + p).join('\n')}`;
  }
  entry.turnStartedAt = Date.now();
  entry.sawInit = false;     // init 闸：本轮是否已见 system/init（每轮 respawn 都会先发）
  entry.initAt = 0;          // init 到达时刻，spawn_ms/ttft_ms 分段锚点
  entry.ttftLogged = false;
  entry.firstTokenAt = 0;        // T2：本轮第一个 content_block_start（真·首字，思考/正文谁先到）
  entry.thinkDoneAt = 0;         // T3：思考块后第一个 text 块 start（思考完成）
  entry.thinkStreamLogged = false; // 标记本轮首块是思考类型，等 text 块收口算 think_ms
  entry.thinkStreamBuf = '';     // 思考流式增量缓冲（节流后瞬时广播给前端，不落库）
  entry.thinkFlushAt = 0;        // 上次 flush 思考增量的时刻（节流锚点）
  writeUserFrame(entry.child.stdin, text, attachments);

  // Wait for result event (or child exit as fallback)
  await new Promise((resolve) => {
    entry._resultResolve = resolve;
  });
}

// ── CC stdout event handler ───────────────────────────────────────────────────
function handleChildEvent(actorId, entry, event) {
  const { state } = entry;
  const replyTo = state.getLastFrom();

  const contextUsage = entry.sawInit ? collectContextUsage(entry, event) : null;
  if (contextUsage) {
    const row = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
    if (row) {
      const m = JSON.parse(row.meta || '{}');
      m.lastUsage = contextUsage;
      safeRun(db.prepare('UPDATE actors SET meta=? WHERE id=?'), JSON.stringify(m), actorId);
      sendToCore({ event: 'actor_updated', actorId });
    }
  }

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        // init 闸：CLI 就绪时刻。spawn_ms（发帧→init 冷启动开销）+ ttft_ms（init→首字）
        // 在首个 assistant 处一行汇总，此处只打点。--print 每轮 respawn 都先发 init。
        entry.initAt = Date.now();
        entry.sawInit = true;
        state.setSessionId(event.session_id, event.model);
        // Persist sessionId + sessionModel（CC 实际选用的模型，让前端显示 opus/sonnet 而不是 provider ID）
        persistSessionInfo(actorId, event.session_id, event.model);
        sendToCore({ event: 'actor_updated', actorId });
        console.log(`[cc-pool] actor ${actorId} session_id=${event.session_id} model=${event.model}`);
      }
      break;

    case 'stream_event': {
      // --include-partial-messages：上方已采集上下文 usage，此处处理时戳和思考增量。
      // init 闸：同 assistant 分支，必须先见本轮 init（跳过 resume 暖启动重放的历史块）。
      if (!entry.sawInit) break;
      const ev = event.event;
      if (ev?.type === 'content_block_start') {
        const blkType = ev.content_block?.type;
        if (!entry.firstTokenAt) {
          entry.firstTokenAt = Date.now();                         // T2 真·首字
          if (blkType === 'thinking') entry.thinkStreamLogged = true; // 首块是思考 → 等 text 块收口
        } else if (blkType === 'text' && entry.thinkStreamLogged && !entry.thinkDoneAt) {
          entry.thinkDoneAt = Date.now();                          // T3 思考完成
        }
      } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        // 思考流式增量：累积 + 节流（≥200ms）瞬时广播给前端，让用户实时看到思考进度，
        // 不再「假死」等整块。注意：只广播不落库——完整 thinking 块仍在 assistant 分支落库做权威，
        // 刷新页面从 DB 读到的是完整块，流式增量是纯瞬时旁路。
        entry.thinkStreamBuf += ev.delta.thinking || '';
        const now = Date.now();
        if (now - entry.thinkFlushAt >= 200 && entry.thinkStreamBuf) {
          sendToCore({ event: 'stream_delta', actorId, toId: replyTo, subtype: 'thinking', text: entry.thinkStreamBuf });
          entry.thinkStreamBuf = '';
          entry.thinkFlushAt = now;
        }
      } else if (ev?.type === 'content_block_stop' && entry.thinkStreamBuf) {
        // 思考块收口，flush 残余增量（防最后一段不足节流窗被吞）
        sendToCore({ event: 'stream_delta', actorId, toId: replyTo, subtype: 'thinking', text: entry.thinkStreamBuf });
        entry.thinkStreamBuf = '';
      }
      break;
    }

    case 'assistant': {
      // init 闸：必须先见本轮 init 再记 TTFT，跳过 resume 暖启动在 init 前重放的历史 assistant
      // （否则锁定假小 TTFT，如 74ms）。分两段：spawn_ms=冷启动开销，ttft_ms=纯模型首字（关键数字）。
      if (entry.sawInit && !entry.ttftLogged) {
        entry.ttftLogged = true;
        const spawn_ms = entry.initAt - entry.turnStartedAt;
        const ttft_ms = Date.now() - entry.initAt;   // 向后兼容：init→首条完整消息（仍含 ttfb+think+text）
        const total_ms = spawn_ms + ttft_ms;
        // partial-messages 拆段（na=-1，避免相减出负数误导）：
        //   ttfb_ms  = init→真·首字(T2)：上行+服务端排队+prefill（配 stderr 429 判限流 vs 排队）
        //   think_ms = 首字(T2)→思考完成(T3)：他真在想，与网络无关
        const ttfb_ms = entry.firstTokenAt ? entry.firstTokenAt - entry.initAt : -1;
        const think_ms = (entry.firstTokenAt && entry.thinkDoneAt) ? entry.thinkDoneAt - entry.firstTokenAt : -1;
        console.log(`[cc-pool] TTFT actor=${actorId} spawn_ms=${spawn_ms} ttfb_ms=${ttfb_ms} think_ms=${think_ms} ttft_ms=${ttft_ms} total_ms=${total_ms}`);
      }
      const blocks = event.message?.content || [];
      // assistant usage 累加进 turnUsage；上下文由 collectContextUsage 独立采集末尾修正。
      if (event.message?.usage) {
        const u = event.message.usage;
        if (entry.turnUsage) {
          if (!entry.firstLoopUsage) entry.firstLoopUsage = { ...u };
          entry.turnUsage.input_tokens += u.input_tokens || 0;
          entry.turnUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
          entry.turnUsage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
          entry.turnUsage.output_tokens += u.output_tokens || 0;
        }
      }
      for (const blk of blocks) {
        if (blk.type === 'text' && blk.text) {
          // 拆 [SHARE:path] → 干净文本 + 独立 share 消息（数量任意）
          const { cleanText, shares } = parseAndExtractShares(blk.text, actorId);
          if (cleanText) {
            emitMsg(actorId, replyTo, 'text', { text: cleanText });
            state.incMsgOut();
          }
          for (const sh of shares) {
            emitMsg(actorId, replyTo, 'share', sh);
          }
        } else if (blk.type === 'tool_use') {
          emitMsg(actorId, replyTo, 'tool_call', blk);
          persistLastTool(actorId, blk.name || 'tool');
          // 累计本轮工具用量（turn_done 时一并回传给 UI）
          const tn = blk.name || 'tool';
          entry.turnTools = entry.turnTools || {};
          entry.turnTools[tn] = (entry.turnTools[tn] || 0) + 1;
          sendToCore({ event: 'actor_updated', actorId });
        } else if (blk.type === 'thinking') {
          emitMsg(actorId, replyTo, 'event', { event_type: 'thinking', thinking: blk.thinking });
        }
      }
      break;
    }

    case 'result': {
      safeRun(db.prepare("UPDATE actors SET status='idle', last_seen=? WHERE id=?"), Date.now(), actorId);
      sendToCore({ event: 'actor_status', actorId, status: 'idle' });
      // CC SDK 的 total_cost_usd 是 session 累计值；卡片要显示"本轮花费"——做差
      const prevRow = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
      const prevMeta = prevRow ? JSON.parse(prevRow.meta || '{}') : {};
      const prevTotal = prevMeta.totalCost || 0;
      const turnCost = (event.total_cost_usd != null)
        ? Math.max(0, event.total_cost_usd - prevTotal)
        : null;
      const turnUsage = entry.turnUsage || event.usage || null;
      emitMsg(actorId, replyTo, 'event', {
        event_type: 'turn_done',
        turns: event.num_turns,
        cost_usd: turnCost,                   // 本轮花费（非 session 累计），累计存 actor.meta.totalCost
        duration_ms: event.duration_ms,
        usage: turnUsage,                     // 本轮 token 累计（跨 tool loop 真实总和，非 SDK 最后一次值）
        first_loop_usage: entry.firstLoopUsage || null, // 首次 loop 的 usage（跨轮缓存复用的真实指标）
        tools: entry.turnTools || {},         // 本轮工具用量 {Bash:3, Read:1}
        stop_reason: event.stop_reason || null,
      });
      // 累加本轮 token 进 session 总量（卡片用），cost 仍覆盖（SDK 给的就是累计）
      const turnTokTotal = turnUsage
        ? (turnUsage.input_tokens || 0) + (turnUsage.cache_creation_input_tokens || 0)
          + (turnUsage.cache_read_input_tokens || 0) + (turnUsage.output_tokens || 0)
        : 0;
      let dirty = false;
      if (event.total_cost_usd) { prevMeta.totalCost = event.total_cost_usd; dirty = true; }
      if (turnTokTotal) { prevMeta.totalTokens = (prevMeta.totalTokens || 0) + turnTokTotal; dirty = true; }
      if (dirty) {
        safeRun(db.prepare('UPDATE actors SET meta=? WHERE id=?'), JSON.stringify(prevMeta), actorId);
        sendToCore({ event: 'actor_updated', actorId });
      }
      if (entry._resultResolve) {
        entry._resultResolve();
        entry._resultResolve = null;
      }
      break;
    }

    case 'control_response':
      if (replyTo) {
        emitMsg(actorId, replyTo, 'event', {
          event_type: 'control_ack',
          request_id: event.response?.request_id,
        });
      }
      break;
  }
}

function persistSessionInfo(actorId, sessionId, sessionModel) {
  const row = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
  if (!row) return;
  const meta = JSON.parse(row.meta || '{}');
  meta.sessionId = sessionId;
  if (sessionModel) meta.sessionModel = sessionModel;
  safeRun(db.prepare('UPDATE actors SET meta=? WHERE id=?'), JSON.stringify(meta), actorId);
}

function persistLastTool(actorId, toolName) {
  const row = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
  if (!row) return;
  const meta = JSON.parse(row.meta || '{}');
  meta.lastTool = toolName;
  safeRun(db.prepare('UPDATE actors SET meta=? WHERE id=?'), JSON.stringify(meta), actorId);
}

function emitMsg(fromId, toId, kind, payload) {
  if (!toId) return;
  const res = safeRun(
    db.prepare('INSERT INTO messages (from_id, to_id, kind, payload, ts) VALUES (?,?,?,?,?)'),
    fromId, toId, kind, JSON.stringify(payload), Date.now()
  );
  // 写被锁争用丢弃(res===null):不通知 core 广播一条并不存在的消息,直接返回
  if (res === null) return;
  // Notify core to broadcast
  sendToCore({ event: 'new_message' });
}

// ── Startup ───────────────────────────────────────────────────────────────────
// 上次 cc-pool 死掉时残留 busy 的 actor 全部回 idle —— 没有活子进程的 actor 不可能 busy。
// 否则 UI 会卡在"Read XXm" 永远不动，直到用户再发一条新消息才被动复活。
const reset = db.prepare(
  "UPDATE actors SET status='idle', last_seen=? WHERE kind='cc' AND status='busy'"
).run(Date.now());
if (reset.changes > 0) {
  console.log(`[cc-pool] reset ${reset.changes} stale busy actors → idle (previous pool died mid-turn)`);
}

const existing = db.prepare("SELECT * FROM actors WHERE kind='cc' AND status!='gone'").all();
for (const row of existing) {
  const meta = JSON.parse(row.meta || '{}');
  children.set(row.id, makeEntry(row.id, meta));
  // 给每个被恢复的 actor 发一条 turn_done(interrupted)，UI 才能摘掉转圈
  if (reset.changes > 0) {
    const lastUserMsg = db.prepare(
      "SELECT from_id FROM messages WHERE to_id=? AND kind='user_msg' ORDER BY id DESC LIMIT 1"
    ).get(row.id);
    if (lastUserMsg?.from_id) {
      emitMsg(row.id, lastUserMsg.from_id, 'event', {
        event_type: 'turn_done',
        interrupted: true,
        reason: 'cc-pool restart',
      });
    }
    sendToCore({ event: 'actor_status', actorId: row.id, status: 'idle' });
  }
}
console.log(`[cc-pool] started pid=${process.pid}, loaded ${existing.length} cc actors`);

// 未捕获异常 / Promise rejection 必须打印再退出，禁止静默死（原代码裸进程 exit 是日志黑洞）。
// 进程级判别式兜底(2026-07):若冒到顶层的仍是可恢复的写锁争用错(SQLITE_BUSY/database is locked),
// 记 WARN 后 return **不退出**——一条丢帧不该掀翻整个 pool、断掉所有 CC 终端。这是判别式放行,
// 不是一刀切静默:真致命错(schema/约束/代码错等)照样 error+exit(1),维持可观测性。
process.on('uncaughtException', (err) => {
  if (isRecoverableDbError(err)) {
    console.warn('[cc-pool] recoverable db-busy at top-level, not exiting:', err?.message);
    return;
  }
  console.error('[cc-pool] FATAL uncaughtException:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (isRecoverableDbError(reason)) {
    console.warn('[cc-pool] recoverable db-busy at top-level, not exiting:', reason?.message);
    return;
  }
  console.error('[cc-pool] FATAL unhandledRejection:', reason?.stack || reason);
  process.exit(1);
});
process.on('SIGTERM', () => { console.log('[cc-pool] SIGTERM, exiting'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[cc-pool] SIGINT, exiting');  process.exit(0); });

connectToCore();

// 周期兜底补扫:socket 一直连着、但单条 new_message 通知被 pool-registry.send 丢弃
// (半死 socket 窗口/主进程重启缝隙)时,若目标 actor 已 idle,该消息会永久躺库不投递
// (重连 drainPending 也补不到——socket 没断)。这里每 3s 主动扫一遍未消费消息,把
// cc-pool 侧的"通知至多一次"补成"至少一次、最迟 3s 自愈"。deliverLoop 幂等(delivering 闸),
// 空扫仅一条索引化 SELECT,代价可忽略。对齐 V1 的后台对账、根治空闲后偶发漏投。
setInterval(drainPending, 3000);

// idle 子进程回收（见 sweepIdleChildren 上方说明）。unref：绝不因为它而吊住进程退出。
setInterval(sweepIdleChildren, IDLE_SWEEP_MS).unref();
