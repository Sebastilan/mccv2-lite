// state.js — actor 状态模型 + 常量 + UI 状态（纯数据，无 DOM）

import { bus } from './bus.js';

// ─── BASE_PATH ───

function detectBasePath() {
  const p = location.pathname;
  const knownRoots = new Set(['api', 'auth', 'data', 'review.html', 'sw.js']);
  const seg = p.split('/').filter(Boolean);
  if (seg.length > 0 && !knownRoots.has(seg[0]) && !seg[0].includes('.')) return '/' + seg[0];
  return '';
}

export const BASE_PATH = detectBasePath();

// ─── 常量 ───

export const WS_PING_INTERVAL_MS = 25000;
export const WS_INITIAL_RECONNECT_MS = 1000;
export const WS_MAX_RECONNECT_MS = 10000;
export const WS_RECONNECT_BACKOFF = 1.5;
export const MAX_EVENTS_PER_ACTOR = 500;
export const TEXTAREA_MAX_HEIGHT_PX = 120;
export const RENAME_MAX_LENGTH = 40;
export const CHIP_ANIMATION_DELAY_MS = 80;
export const MAX_TOAST_COUNT = 3;
export const TOAST_AUTO_DISMISS_MS = 8000;
export const USAGE_FETCH_INTERVAL_MS = 5 * 60 * 1000;
export const USAGE_DANGER_THRESHOLD = 90;
export const USAGE_WARN_THRESHOLD = 70;
export const BUSY_TIMER_INTERVAL_MS = 1000;
export const RELOAD_DELAY_MS = 100;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
export const MACHINES_POLL_MS = 30_000;

export const STATUS = { creating: '创建中', idle: '空闲', busy: '执行中', cancelled: '已关闭', failed: '异常', gone: '已消失' };

// ─── 模型 id → UI 标签（新建弹窗 + /model 切换 + 历史 resume 抽屉共用）───
export const MODEL_LABELS = {
  'claude-opus-5-5[1m]': 'Opus 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5[1m]': 'Opus 5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
};

// ─── 慢聊（chat）可选模型：deepseek-* 直连 DeepSeek（DEEPSEEK_API_KEY），
// 其余发给 PROVIDER_CHAT_URL 指向的 Anthropic 兼容网关（见 adapters/chat/chat.mjs）。
// cc 终端的清单在后端 /api/provider，不在这里。首位 = 默认。
export const CHAT_MODELS = [
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1',
];

/** kind → 可选模型 id 数组；cc 返回 null（表示要去问 /api/provider）。 */
export function modelsForKind(kind) {
  if (kind === 'chat') return CHAT_MODELS;
  return null;
}

// ─── DOM helper ───

export const $ = (s) => document.querySelector(s);

// ─── actor → terminal 视图对象转换（仅在 state 层做，供 ui/ 消费） ───
// v2 actor 字段 meta 存 JSON 字符串 or 对象，统一返回对象

export function parseMeta(actor) {
  if (!actor) return {};
  if (typeof actor.meta === 'string') {
    try { return JSON.parse(actor.meta); } catch { return {}; }
  }
  return actor.meta || {};
}

export function actorToTerminal(actor) {
  const meta = parseMeta(actor);
  return {
    id: actor.id,
    kind: actor.kind || 'cc',
    status: actor.status === 'gone' ? 'cancelled' : (actor.status || 'idle'),
    role: meta.role || '',
    pinTop: !!meta.pinTop,
    pinLabel: meta.pinLabel || '',
    slotId: meta.slotId || '',
    project: meta.projectPath || actor.id,
    name: meta.customName || meta.name || '',
    model: meta.sessionModel || meta.model || '',
    provider: meta.provider || meta.model || '',
    callbackTerminalId: meta.callbackActorId || meta.callbackTerminalId || '',
    advisorType: meta.advisorType || 'main',
    lightweight: !!meta.lightweight,
    contextMode: !!meta.contextMode,
    lastActivityAt: actor.last_seen || actor.created_at || Date.now(),
    lastUserMessage: meta.lastMessage || '',
    recentSummary: meta.recentSummary || '',
    currentTask: meta.currentTask || '',
    task: meta.task || '',
    lastUsage: meta.lastUsage || null,
    contextWindow: meta.contextWindow || 1_000_000,
    totalCost: meta.totalCost || 0,
    totalTokens: meta.totalTokens || 0,
    lastTool: meta.lastTool || '',
    lastSuggestions: meta.lastSuggestions || [],
    locked: !!meta.locked,
    mode: meta.mode || (meta.callbackActorId ? 'worker' : 'advisor'),
    owner: meta.owner || '',
  };
}

// ─── msg → v1 event 转换（bus messages → terminal stream events） ───

function tsToTime(ts) {
  return new Date(ts || Date.now()).toTimeString().substring(0, 8);
}

export function msgToEvent(msg) {
  const time = tsToTime(msg.ts);
  if (msg.kind === 'text') {
    return { time, action: 'reply', detail: msg.payload?.text || '' };
  }
  if (msg.kind === 'share') {
    // share kind 作为事件流条目（与 thinking/tool_call 同等）
    return { time, action: 'share', payload: msg.payload || {} };
  }
  if (msg.kind === 'tool_call') {
    const p = msg.payload || {};
    const name = p.name || p.type || 'tool';
    const input = p.input || {};
    const argText = input.command || input.file_path || input.description ||
      (typeof input === 'string' ? input : Object.keys(input).length ? JSON.stringify(input) : '');
    return { time, action: 'tool_call', toolName: name, callId: p.id || '', detail: String(argText || ''), input };
  }
  if (msg.kind === 'user_msg') {
    const text = msg.payload?.text || '';
    const atts = Array.isArray(msg.payload?.attachments) ? msg.payload.attachments : [];
    const imgMds = atts.filter(a => (a.mimeType || '').startsWith('image/'))
      .map(a => `![${a.name || 'image'}](${a.data})`).join('\n');
    const fileMarks = atts.filter(a => !(a.mimeType || '').startsWith('image/'))
      .map(a => `📎 ${a.name || 'file'}`).join('  ');
    const detail = [text, imgMds, fileMarks].filter(Boolean).join('\n');
    // queued: 已知未 started 且 actor 还在 busy/creating —— 见 msg_started 后清掉
    const toActor = state.actors.get(msg.to_id);
    const actorBusy = toActor && (toActor.status === 'busy' || toActor.status === 'creating');
    const queued = actorBusy && !state.startedMsgIds.has(msg.id);
    return { time, action: 'user_message', detail, msgId: msg.id, queued };
  }
  if (msg.kind === 'event') {
    const { event_type } = msg.payload || {};
    if (event_type === 'turn_done') {
      const c = msg.payload.cost_usd;
      const d = msg.payload.duration_ms;
      const turns = msg.payload.turns;
      const u = msg.payload.usage;
      const fu = msg.payload.first_loop_usage;
      const tools = msg.payload.tools;
      const parts = [];
      if (turns != null) parts.push(`${turns}轮`);
      if (c != null) parts.push(`$${c.toFixed(3)}`);
      if (d != null) parts.push(`${(d / 1000).toFixed(1)}s`);
      if (u) {
        const inSum = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const tot = inSum + (u.output_tokens || 0);
        if (tot > 0) parts.push(`${(tot / 1000).toFixed(1)}K tok`);
        const cu = fu || u;
        const cuIn = (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0);
        if (cuIn > 0) {
          const hit = Math.round((cu.cache_read_input_tokens || 0) / cuIn * 100);
          parts.push(`cache ${hit}%`);
        }
      }
      if (tools && Object.keys(tools).length) {
        parts.push(Object.entries(tools).map(([k, v]) => `${k}×${v}`).join(' '));
      }
      const detail = parts.length ? `完成 (${parts.join(', ')})` : '完成';
      return { time, action: 'turn_summary', detail };
    }
    if (event_type === 'created') {
      const label = msg.payload.resumed ? '已接续对话' : '终端就绪';
      return { time, action: 'created', detail: `${label} — ${msg.payload.project || ''}` };
    }
    if (event_type === 'thinking') return { time, action: 'thinking', detail: msg.payload.thinking || '' };
    if (event_type === 'control_ack') return null;
    if (event_type === 'msg_started') {
      // 派 bus 事件让 ui 层摘掉对应 bubble 的"排队中"标记（保持 state.js 无 DOM）
      // 同时记到 startedMsgIds —— 历史重建时该消息不会再被误判为 queued
      const mid = msg.payload?.msg_id;
      if (mid != null) { state.startedMsgIds.add(mid); bus.emit('msg:started', mid); }
      return null;
    }
    // tool_purpose 已停用（2026-10-01）：历史事件静默吞掉，避免落到下方 system 分支
    if (event_type === 'tool_purpose') return null;
    if (event_type === 'ask_pending') {
      return { time, action: 'ask_pending', askId: msg.payload.ask_id, questions: msg.payload.questions || [] };
    }
    if (event_type === 'ask_answered') {
      return { time, action: 'ask_answered', askId: msg.payload.ask_id, answers: msg.payload.answers || [] };
    }
    return { time, action: 'system', detail: event_type || '' };
  }
  return null;
}

// ─── 全局状态 ───

export const state = {
  // actor 模型层
  actors: new Map(),            // actorId → actor
  messagesByActor: new Map(),   // actorId → msg[]
  selfId: 'human_self',

  // dashboard 上显示的 actor 视图列表（排除内部 service / 人类 actor）
  // 加新 actor kind（codex/terra 等）默认就能进 dashboard，不用动这里
  get dashboardData() {
    return [...this.actors.values()]
      .filter(a => a.status !== 'gone' && a.kind !== 'service' && a.kind !== 'human')
      .map(actorToTerminal);
  },

  // 终端事件流（actorId → v1-event[]，由消息转换填充）
  terminalEvents: new Map(),
  terminalDOM: new Map(),
  lastHistoryFetch: new Map(),  // actorId → ts（ms），用于切换 tab 时跳过冗余 HTTP
  oldestLoaded: new Map(),      // actorId → 已加载的最早 msg id，上滑加载更早历史的游标
  historyLoaded: new Set(),     // 已真正拉过"首屏一页"的 actor（区别于仅有 WS 累积消息，决定首拉走分页还是增量）
  streamingBubbles: new Map(),
  unreadTerminals: new Set(),
  startedMsgIds: new Set(),      // 已收到 msg_started 的 user_msg id，用于历史回放时判 queued

  // UI 状态
  ws: null,
  reconnectDelay: WS_INITIAL_RECONNECT_MS,
  pingTimer: null,
  currentTerminalId: null,      // 当前打开的 actorId
  scopedActorId: null,          // 分享链接访客模式：非 null 即被收窄到该 actor（纯 UX，安全边界在后端）
  wasConnected: false,
  attachments: [],
  _pendingCreate: false,
  currentSuggestions: [],
  _navSkip: false,
  _collapsedSections: new Set(['workers']),
  pinSlots: [],          // [{id, label, spawnMeta}] — 由 GET /api/pin-slots 周期拉取

  // slash/mention menu
  slashVisible: false, slashIdx: -1, slashItems: [], slashSkills: null,
  mentionVisible: false, mentionIdx: -1, mentionItems: [],

  // busy timer
  busyTimer: null, busyStartTs: 0,

  // @ mention 待发送列表（由 actor-mention 插件 push，sendMsg 消费后清空）
  // 每项: { actor_id, name, token: '@<name>' }
  pendingMentions: [],

  // machines
  _machinePopover: null, _machinesCache: [],
  // drag
  _dragCount: 0,

  // ─── 方法 ───

  upsertActor(actor) {
    const existing = this.actors.get(actor.id);
    // 保留更完整的 meta（避免 actor_update 缺字段时覆盖）
    if (existing && typeof actor.meta === 'string' && actor.meta === '{}') {
      actor = { ...actor, meta: existing.meta };
    }
    this.actors.set(actor.id, actor);
  },

  removeActor(actorId) {
    this.actors.delete(actorId);
    this.messagesByActor.delete(actorId);
    this.terminalEvents.delete(actorId);
    this.terminalDOM.delete(actorId);
    this.unreadTerminals.delete(actorId);
    this.oldestLoaded.delete(actorId);
    this.lastHistoryFetch.delete(actorId);
    this.historyLoaded.delete(actorId);
  },

  // 归档"自己发出"的消息到 messagesByActor（带 id 去重）。
  // 广播器只投递给 to_id 及其订阅者，不会把发送方自己的消息回灌人类自己的 WS，
  // 所以用户发的 user_msg 永远不会经 appendMessage 进 messagesByActor，只活在乐观 pushEvent 的
  // terminalEvents 里。而 rebuildTerminalEvents 纯从 messagesByActor 重建——上滑分页/重入增量
  // 加载一旦触发重建，就会擦掉用户自己的消息（只有整页 reload 从 DB 重取才回来）。
  // 发送成功后在这里补归档，使重建无损。
  archiveSelfMessage(actorId, msgId, kind, payload, ts) {
    if (msgId == null) return;
    const msg = { id: msgId, from_id: this.selfId, to_id: actorId, kind, payload: payload || {}, ts: ts || Date.now() };
    for (const aid of [msg.from_id, msg.to_id]) {
      if (!this.messagesByActor.has(aid)) this.messagesByActor.set(aid, []);
      const arr = this.messagesByActor.get(aid);
      if (!arr.some(m => m.id === msg.id)) arr.push(msg);
    }
  },

  appendMessage(msg) {
    // 双向归档到 messagesByActor
    for (const aid of [msg.from_id, msg.to_id]) {
      if (!this.messagesByActor.has(aid)) this.messagesByActor.set(aid, []);
      this.messagesByActor.get(aid).push(msg);
    }
    // 确定事件归属 actorId（非 human 的那端）
    const actorId = (msg.from_id === this.selfId) ? msg.to_id : msg.from_id;
    const evt = msgToEvent(msg);
    if (evt) {
      if (!this.terminalEvents.has(actorId)) this.terminalEvents.set(actorId, []);
      const list = this.terminalEvents.get(actorId);
      list.push(evt);
      if (list.length > MAX_EVENTS_PER_ACTOR) list.splice(0, list.length - MAX_EVENTS_PER_ACTOR);
    }
  },

  getActorsByRole(role) {
    return [...this.actors.values()].filter(a => parseMeta(a).role === role);
  },

  // 更新 actor meta 中的某个字段（本地乐观更新）
  patchActorMeta(actorId, patch) {
    const actor = this.actors.get(actorId);
    if (!actor) return;
    const meta = parseMeta(actor);
    const newMeta = { ...meta, ...patch };
    this.actors.set(actorId, { ...actor, meta: newMeta });
  },
};
