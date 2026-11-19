// api-events.mjs — GET /api/events：SSE 通知端点（MCC 通知闭环服务端半场）
//
// 面板"不在场"时（Android app 后台/锁屏），SPA 的 WS 断链就聋了——advisor 回复了、
// worker 干完了、SHARE 发过来了，平板毫无反应。SSE 长连接把这几类事件主动推给原生
// 前台服务 → 系统通知 → tap 深链直达 chat（浏览器端 P-A2）。
//
// 复用同一事件源，不另造事件流：
//   - message  ← 消息日志（bus.getNewMessagesSince，与 broadcaster.pollMissed 同一张 messages 表；
//                cc-pool 是独立进程，advisor 回复只落库不走主进程 bus.insertMessage，故走 DB 游标）
//   - alert    ← 同一消息游标（kind=event 且 worker_done status=error 的行）
//   - actor_idle ← bus 'actor_status' 事件（notify-server 收 cc-pool busy/idle 后 emit）
//
// nginx 默认 buffering 会吃掉 SSE；响应头带 X-Accel-Buffering:no 即秒级流式穿透（nginx 零改动）。
//
// 三类事件，data 均为单行 JSON {actorId, actorName?, preview?(前120字), ts, channel}：
//   event: message     发给人类的新消息，攒到本轮结束才推一次（见下「合并」）      channel=human （高优先级）
//   event: actor_idle  actor busy→idle 且本轮没给人类发过消息（纯静默干活）        channel=status（低优先级）
//   event: alert       worker 异常结束（worker_done status=error）                channel=status
//
// 合并（coalesce）：CC 一轮回复底层是多个 text 块（开头说两句→调工具→再说→…→结尾摘要），
// 逐条弹 HIGH 会在后台/锁屏时把用户一轮轰 N 次。改为攒着不弹：发给人类的 text/share 只写进
// pending[actor]（text 覆盖 textPreview 取后 120 字，share 覆盖 sharePreview），等该 actor
// 本轮 idle（cc-pool busy→idle，精确的「一轮结束」信号）时 flush 一次 HIGH，preview 优先取
// 最后一条 text、无 text 才退回 share。防丢兜底：写 pending 时同时武装一个 debounce 定时器，
// 万一 idle 信号迟迟不来也会在 FLUSH_DEBOUNCE_MS 后自动推一次，绝不把摘要永久吞掉。
//
// v1 明确不做 Last-Event-ID 回放：断线期错过的事件不补，重连后只收新事件。

const HUMAN_ID = 'human_self';
const PING_MS  = 25_000;   // 心跳注释间隔，防中间层空闲断链
const POLL_MS  = 1_000;    // 消息日志游标轮询间隔（秒级到达）
// 攒到本轮结束才推的两个时限，env 可覆盖（测试用小值快跑）：
const FLUSH_DEBOUNCE_MS   = Number(process.env.EVENTS_DEBOUNCE_MS) || 8000;   // idle 信号迟到时的防丢兜底
const IDLE_FLUSH_DELAY_MS = Number(process.env.EVENTS_IDLE_DELAY_MS) || 400;  // 吸收 cc-pool 跨进程落库延迟

const clients = new Set();  // Set<res>
let cursor = null;          // messages 日志游标（懒初始化到当前末尾，v1 不回放历史）
// 每 actor 攒本轮发给人类的最后一条摘要，等 idle / 兜底 debounce 时 flush 一次。
const pending = new Map();   // actorId -> { textPreview, sharePreview, ts, actorName, timer }

function actorName(bus, id) {
  try {
    const row = bus.db.prepare('SELECT meta FROM actors WHERE id=?').get(id);
    return row ? (JSON.parse(row.meta || '{}').name || undefined) : undefined;
  } catch { return undefined; }
}

function emit(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { /* 死 socket，close 会清 */ } }
}

// flush(actorId)：把 actor 攒的本轮摘要推一次 HIGH（message），并撤掉其 pending 项与 debounce。
// preview 优先取最后一条 text，无 text 才退回 share。返回是否真的 emit 了 HIGH
// （供 idle 分支判断：没 emit 说明本轮纯静默干活，才补一条 actor_idle 的 LOW 提示）。
function flush(actorId) {
  const entry = pending.get(actorId);
  if (!entry) return false;
  pending.delete(actorId);
  if (entry.timer) clearTimeout(entry.timer);
  const preview = entry.textPreview || entry.sharePreview;
  if (!clients.size || !preview) return false;
  emit('message', { actorId, actorName: entry.actorName, preview, ts: entry.ts, channel: 'human' });
  return true;
}

// 消息日志游标：扫 (cursor, max] 新消息，把发给人类的回复攒进 pending（不立即弹）/ 即时推 worker 告警。
// 游标始终推进（即便无客户端），保证新连接不会灌到历史积压。
function pollMessages(bus) {
  if (cursor == null) cursor = bus.getMaxMessageId();
  let msgs;
  try { msgs = bus.getNewMessagesSince(cursor); } catch { return; }
  for (const m of msgs) {
    cursor = m.id;
    if (!clients.size) continue;
    const p = m.payload || {};
    if (m.to_id === HUMAN_ID && (m.kind === 'text' || m.kind === 'share')) {
      // 攒着不弹：覆盖本轮该 actor 的最新摘要，等 idle / debounce 再 flush 一次。
      let entry = pending.get(m.from_id);
      if (!entry) { entry = { textPreview: '', sharePreview: '', ts: m.ts, actorName: undefined, timer: null }; pending.set(m.from_id, entry); }
      if (m.kind === 'text') entry.textPreview = String(p.text || '').slice(0, 120);
      else                   entry.sharePreview = `📎 ${p.name || '文件'}`;
      entry.ts = m.ts;
      entry.actorName = actorName(bus, m.from_id) || entry.actorName;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flush(m.from_id), FLUSH_DEBOUNCE_MS);
      entry.timer.unref?.();
    } else if (m.kind === 'event' && p.name === 'worker_done' && p.status === 'error') {
      const workerId = p.workerId || m.from_id;
      emit('alert', { actorId: workerId, actorName: actorName(bus, workerId), preview: String(p.summary || 'worker 异常结束').slice(0, 120), ts: m.ts, channel: 'status' });
    }
  }
}

/**
 * 装配事件源（进程内只调一次，main.mjs 接线）。挂 bus 'actor_status' 监听 + 起游标/心跳定时器。
 * 定时器 unref，不吊住进程；监听器是模块级单例（非 per-client），进程存活期常驻、零泄漏。
 */
export function attachEventStream(bus) {
  cursor = bus.getMaxMessageId();
  bus.on('actor_status', ({ actorId, status }) => {
    if (status !== 'idle' || !clients.size) return;
    // 「一轮结束」精确信号：延时吸收 cc-pool 跨进程落库延迟后，先排空最后摘要再 flush 一次 HIGH。
    // flush 没推 HIGH（该 actor 本轮没给人类发过消息，纯静默干活）才补一条 actor_idle 的 LOW 提示。
    const t = setTimeout(() => {
      pollMessages(bus);
      if (!flush(actorId) && clients.size) {
        emit('actor_idle', { actorId, actorName: actorName(bus, actorId), ts: Date.now(), channel: 'status' });
      }
    }, IDLE_FLUSH_DELAY_MS);
    t.unref?.();
  });
  setInterval(() => pollMessages(bus), POLL_MS).unref?.();
  setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, PING_MS).unref?.();
}

/**
 * GET /api/events —— SSE 长连接。鉴权已由 server.mjs 入口 checkAuth 完成
 * （/api/events 非白名单 → 无有效 mcc_auth cookie 时 checkAuth 已回 401，不会走到这里）。
 */
export function handleEventsApi(req, res, bus) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/api/events') return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx 不缓冲，秒级流式穿透
  });
  res.write(': connected\n\n');   // 立即刷 header（穿过 http-compress 的流式让路）

  clients.add(res);
  console.log(`[events] SSE client connected (total=${clients.size})`);

  const cleanup = () => {
    if (clients.delete(res)) console.log(`[events] SSE client disconnected (total=${clients.size})`);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  return true;
}
