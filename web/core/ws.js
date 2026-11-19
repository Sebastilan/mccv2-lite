// ws.js — WS 连接 + actor 协议订阅（无 DOM，纯事件分发）

import { bus } from './bus.js';
import { state, WS_PING_INTERVAL_MS, WS_INITIAL_RECONNECT_MS, WS_MAX_RECONNECT_MS, WS_RECONNECT_BACKOFF, BASE_PATH, msgToEvent, parseMeta } from './state.js';
import { listActors, getActorMessages, getHistoryDetail } from './api.js';
import { prefetchActors } from './prefetch.js';

const WS_CONNECT_TIMEOUT_MS = 5000;
const WS_STALE_FACTOR = 2.4;   // 超过 2.4×ping 周期无任何服务端消息 = socket 已「半死」，强制重连
let _connectTimer = null;
let _reconnectTimer = null;
let _lastActivity = 0;         // 最近一次收到任何服务端消息（含 pong）的时间戳

// ─── 连接 ───

export function connect() {
  // Idempotent: skip if already open or connecting
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    old.onclose = null; old.onerror = null; old.onopen = null;
    if (old.readyState !== WebSocket.CLOSED) try { old.close(); } catch (_) {}
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}${BASE_PATH}/`);
  state.ws = ws;

  _connectTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.onclose = null;
      try { ws.close(); } catch (_) {}
      scheduleReconnect();
    }
  }, WS_CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
    state.wasConnected = true;
    state.reconnectDelay = WS_INITIAL_RECONNECT_MS;
    _lastActivity = Date.now();
    state.pingTimer = setInterval(() => {
      // 半死检测：服务端对每个 ping 即时回 pong，健康连接每周期都有活动。
      // 移动端锁屏后 socket 可能 readyState=OPEN 但底层已断（onclose 不触发）——
      // 这里超时即主动 teardown + 重连，否则只能靠用户手动刷新。
      if (Date.now() - _lastActivity > WS_PING_INTERVAL_MS * WS_STALE_FACTOR) {
        console.warn('[ws] no server activity — forcing reconnect (half-dead socket)');
        forceReconnect(ws);
        return;
      }
      send({ type: 'ping' });
    }, WS_PING_INTERVAL_MS);
    ws.send(JSON.stringify({ type: 'register', actorId: state.selfId }));
    bus.emit('ws:open');
    startReconcileLoop();   // A1: 周期对账兜底（幂等，只启一次）
  };

  ws.onclose = () => {
    if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
    if (state.ws !== ws) return;
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
    bus.emit('ws:closed');
    scheduleReconnect();
  };

  ws.onerror = (err) => console.error('[ws] error:', err);

  ws.onmessage = (e) => {
    _lastActivity = Date.now();
    try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error('[ws] parse error:', err); }
  };
}

// 强制重连：丢弃半死 socket（不信任 readyState）并立即重建。
export function forceReconnect(deadWs) {
  if (deadWs) { deadWs.onclose = null; deadWs.onerror = null; deadWs.onmessage = null; try { deadWs.close(); } catch (_) {} }
  if (state.ws === deadWs) {
    state.ws = null;
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
  }
  bus.emit('ws:closed');
  connect();
}

// 前台唤醒探活：移动端回前台时，readyState 可能仍显示 OPEN 但 socket 已半死。
// 主动 ping，6s 内无任何服务端回应即强制重连（不必等下一个 ping 周期）。
export function pokeConnection() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) { connect(); return; }
  const before = _lastActivity;
  send({ type: 'ping' });
  setTimeout(() => {
    if (state.ws === ws && _lastActivity === before) forceReconnect(ws);
  }, 6000);
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * WS_RECONNECT_BACKOFF, WS_MAX_RECONNECT_MS);
}

export function send(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

// ─── 消息路由 ───

function handleMsg(msg) {
  // 心跳 pong：活动时间已在 onmessage 记录，这里只需吞掉不再分发
  if (msg.type === 'pong') return;
  // v2 actor 协议（typed envelope）
  if (msg.type === 'registered') {
    bus.emit('ws:registered', msg.actorId);
    // 注册成功后拉全量 actors
    _fetchInitialActors();
    return;
  }
  if (msg.type === 'actor_update') {
    state.upsertActor(msg.actor);
    bus.emit('actor:update', msg.actor);
    return;
  }
  if (msg.type === 'actor_gone') {
    state.removeActor(msg.actorId);
    bus.emit('actor:gone', msg.actorId);
    return;
  }
  if (msg.type === 'stream_delta') {
    // 思考流式增量（瞬时，不落库）：交给 stream-render 实时追加显示
    bus.emit('stream:delta', msg);
    return;
  }
  if (msg.type === 'message') {
    const m = msg.message;
    // A2: 服务端回推的「自己发出的消息」—— 只做确认归档（带 id 去重），不重复渲染。
    // 乐观 pushEvent 已把气泡显示在界面上；这里把消息落进 messagesByActor，使任何
    // 重连/上滑触发的 rebuildTerminalEvents 都能无损重建这条（POST 慢/失败也不再丢）。
    // 走 appendMessage 会二次 push 进 terminalEvents → 与乐观气泡重影，故独立走 archive-only。
    if (m.from_id === state.selfId) {
      state.archiveSelfMessage(m.to_id, m.id, m.kind, m.payload, m.ts);
      return;
    }
    state.appendMessage(m);
    bus.emit('message:new', m);
    // 当 CC 回复 turn_done 时，本地更新 actor 为 idle
    if (m.kind === 'event' && m.payload?.event_type === 'turn_done') {
      const actor = state.actors.get(m.from_id);
      if (actor) { state.upsertActor({ ...actor, status: 'idle', last_seen: Date.now() }); bus.emit('actor:update', { ...actor, status: 'idle' }); }
    }
    return;
  }
  // 兜底：裸 bus message（from_id/to_id/kind/payload 格式）
  if (msg.from_id || msg.to_id) {
    state.appendMessage(msg);
    bus.emit('message:new', msg);
    if (msg.kind === 'event' && msg.payload?.event_type === 'turn_done') {
      const actor = state.actors.get(msg.from_id);
      if (actor) { state.upsertActor({ ...actor, status: 'idle', last_seen: Date.now() }); bus.emit('actor:update', { ...actor, status: 'idle' }); }
    }
  }
}

// ─── 初始化拉取全量 actors ───

async function _fetchInitialActors() {
  try {
    const actors = await listActors();   // 服务端权威当前集（status!='gone'）
    const liveIds = new Set(actors.map(a => a.id));
    // 权威快照对账：断线期间错过的 actor_gone 会让本地残留「幽灵」actor（已关闭却仍在
    // tab 栏/仪表盘）。重连时按服务端当前集剪掉本地多出来的，避免只能靠刷新清理。
    // self（human_self）不在 dashboard 集内但要保留，跳过。
    let currentGone = false;
    for (const id of [...state.actors.keys()]) {
      if (id === state.selfId || liveIds.has(id)) continue;
      if (id === state.currentTerminalId) currentGone = true;
      state.removeActor(id);
    }
    for (const a of actors) state.upsertActor(a);
    bus.emit('actors:loaded');   // 消费方（app.js _initChatPage）据此补当前终端消息 + 重绘
    // 正在查看的终端已被关闭 → 通知（grid 的 actor:gone 处理会退回仪表盘）
    if (currentGone) bus.emit('actor:gone', state.currentTerminalId);
  } catch (e) {
    console.warn('[ws] failed to load actors:', e);
  }
}

// ─── 为某个 actor 加载历史消息 ───

const HISTORY_PAGE = 200;   // 首屏 / 每页加载条数

// 把一批消息并入 messagesByActor（dedup by id，双向 bucket 到收发两端）
function mergeMessages(actorId, msgs) {
  if (!state.messagesByActor.has(actorId)) state.messagesByActor.set(actorId, []);
  const merged = state.messagesByActor.get(actorId);
  const existing = new Set(merged.map(m => m.id));
  for (const m of msgs) {
    if (existing.has(m.id)) continue;
    existing.add(m.id);
    merged.push(m);
    const other = m.from_id === actorId ? m.to_id : m.from_id;
    if (other && other !== actorId) {
      if (!state.messagesByActor.has(other)) state.messagesByActor.set(other, []);
      const otherArr = state.messagesByActor.get(other);
      if (!otherArr.some(x => x.id === m.id)) otherArr.push(m);
    }
  }
}

// 从 messagesByActor 全量重建 terminalEvents（幂等：每次从空开始，续接 JSONL 前置）
async function rebuildTerminalEvents(actorId) {
  const merged = state.messagesByActor.get(actorId) || [];
  merged.sort((a, b) => a.id - b.id);
  // 预扫 msg_started，msgToEvent 才能在 user_msg 出现时正确判 queued
  for (const m of merged) {
    if (m.kind === 'event' && m.payload?.event_type === 'msg_started') {
      const mid = m.payload?.msg_id;
      if (mid != null) state.startedMsgIds.add(mid);
    }
  }
  state.terminalEvents.set(actorId, []);
  state.terminalDOM.delete(actorId);
  // 续接会话：先把 JSONL 历史对话作为合成事件前置，bus 消息追加在后
  const resumedFrom = parseMeta(state.actors.get(actorId)).resumedFrom;
  if (resumedFrom) {
    try {
      const { messages } = await getHistoryDetail(resumedFrom);
      for (const m of messages || []) {
        state.terminalEvents.get(actorId).push({
          action: m.role === 'assistant' ? 'reply' : 'user_message',
          detail: m.text,
          time: '',
        });
      }
    } catch (e) { console.warn('[ws] resume history fetch failed:', e); }
  }
  for (const m of merged) {
    const evt = msgToEvent(m);
    if (evt) state.terminalEvents.get(actorId).push(evt);
  }
  if (merged.length) state.oldestLoaded.set(actorId, merged[0].id);
}

// 进入终端：首次（没真拉过首屏页）→ 拉最近一页；已拉过 → 只补增量(since)。
// 关键：用 historyLoaded 标记判"是否拉过首屏"，不能用"messagesByActor 有没有消息"——
// WS 会把所有终端的实时消息累积进 messagesByActor，活跃终端 maxId 永远 >0，
// 误走增量分支会导致历史永远补不上（只显示在线期间那几条），下拉也拉不出（bug 2026-06-01）。
export async function loadActorHistory(actorId) {
  try {
    if (state.historyLoaded.has(actorId)) {
      const cached = state.messagesByActor.get(actorId) || [];
      const maxId = cached.reduce((mx, m) => (m.id > mx ? m.id : mx), 0);
      const msgs = await getActorMessages(actorId, { since: maxId });
      mergeMessages(actorId, msgs);
    } else {
      // 首屏：拉最近一页，与已累积的 WS 消息合并（mergeMessages 自带 dedup）
      const msgs = await getActorMessages(actorId, { limit: HISTORY_PAGE });
      mergeMessages(actorId, msgs);
      state.historyLoaded.add(actorId);
    }
    await rebuildTerminalEvents(actorId);
    bus.emit('actor:history', actorId);
  } catch (e) {
    console.warn(`[ws] failed to load history for ${actorId}:`, e);
  }
}

// ─── A1 · 周期对账（丢帧根治）───
//
// 推送是「至多一次、丢了不补」：某条消息 _dispatch 那一瞬 ws 恰好不在推送集（注册缝隙/
// 竞态）就永久丢，socket 健康时又不触发重连补洞，只能手动刷新。这里加一个轻量周期对账：
// 对当前正在看的终端每 ~5s 做一次 getActorMessages(since=本地maxId) 增量合并，绝大多数返回
// 空（近零成本），任何漏帧最坏 ~5s 自愈。visibilitychange/focus/重连时再由 reconcileNow()
// 立即触发一次。注意：since=maxId 补的是「尾部漏帧」（含"输出一半就断"那种最后一段丢失），
// 若丢的是「中间某条、其后仍有新帧」的内部空洞，maxId 已越过它、增量拉不回——那类需整页
// reload 或重连补洞（本任务不覆盖，见交付说明）。

const RECONCILE_INTERVAL_MS = 5000;
const RECONCILE_BG_EVERY = 6;   // 每 6 个周期(~30s)顺带对账其余已加载终端，避免 N 终端×QPS 打库
let _reconcileTimer = null;
let _reconcileTick = 0;
const _reconciling = new Set();

// 对单个 actor 做一次增量对账：只有真有漏帧(msgs 非空)才重建+重绘，空则近零成本返回。
export async function reconcileActor(actorId) {
  if (!actorId || actorId === state.selfId) return;
  if (!state.historyLoaded.has(actorId)) return;   // 首屏还没拉过 → 交给 loadActorHistory
  if (_reconciling.has(actorId)) return;            // 上一轮还在飞，跳过避免叠 HTTP
  _reconciling.add(actorId);
  try {
    const cached = state.messagesByActor.get(actorId) || [];
    const maxId = cached.reduce((mx, m) => (m.id > mx ? m.id : mx), 0);
    const msgs = await getActorMessages(actorId, { since: maxId });
    if (!msgs.length) return;                        // 无漏帧：绝大多数情况
    mergeMessages(actorId, msgs);
    await rebuildTerminalEvents(actorId);
    bus.emit('actor:reconciled', actorId);           // UI 层据此重绘当前终端（app.js 监听）
  } catch (e) {
    console.warn(`[ws] reconcile failed for ${actorId}:`, e);  // 静默，下个周期再试
  } finally {
    _reconciling.delete(actorId);
  }
}

// 立即对账当前终端（visibilitychange/focus/重连 调用）——不等下一个 5s 周期。
export function reconcileNow() {
  reconcileActor(state.currentTerminalId);
}

// 启动周期对账（幂等，单例定时器）。后台隐藏标签不对账，回前台由 reconcileNow 立即补。
export function startReconcileLoop() {
  if (_reconcileTimer) return;
  _reconcileTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    reconcileActor(state.currentTerminalId);
    if (++_reconcileTick % RECONCILE_BG_EVERY === 0) {
      for (const id of state.historyLoaded) {
        if (id !== state.currentTerminalId) reconcileActor(id);
      }
    }
  }, RECONCILE_INTERVAL_MS);
}

// ─── B1 · 进场后台预取（切换即时）───
//
// actors:loaded 后把活跃终端的首屏各拉一页到本地（并发上限，低优先），使切过去命中缓存、
// 0 次现场首屏 HTTP（根治痛点2「切冷终端卡 2-3s」）。编排逻辑在 prefetch.js（纯 DI、可单测），
// 这里只注入真依赖：state + loadActorHistory（复用 A 战线首屏加载器，不重复造）。
// 幂等单飞：actors:loaded 在每次重连也会触发，_prefetching 防重入；已 historyLoaded 的自动跳过。
let _prefetching = false;
export async function prefetchActiveActors() {
  if (_prefetching) return null;
  _prefetching = true;
  try {
    // 中断钩子：页面隐藏时停手（让位前台 / 省流），回前台由下次 actors:loaded 或对账补
    return await prefetchActors(state, loadActorHistory, {
      shouldStop: () => typeof document !== 'undefined' && document.hidden,
    });
  } finally {
    _prefetching = false;
  }
}

// 上滑加载更早一页：取 id < oldestLoaded 的最近一页，prepend 后重建。返回新增条数（0=到顶）。
export async function loadOlderHistory(actorId) {
  const oldest = state.oldestLoaded.get(actorId);
  if (!oldest) return 0;
  try {
    const older = await getActorMessages(actorId, { before: oldest, limit: HISTORY_PAGE });
    if (!older.length) return 0;
    mergeMessages(actorId, older);
    await rebuildTerminalEvents(actorId);
    bus.emit('actor:history', actorId);
    return older.length;
  } catch (e) {
    console.warn(`[ws] failed to load older history for ${actorId}:`, e);
    return 0;
  }
}
