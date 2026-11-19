// app.js — SPA 统一入口：注册所有插件 + 初始化路由 + 全局 WS
import { register, mount, unmountPage } from './canvas/index.js';
import { connect, loadActorHistory, loadOlderHistory, pokeConnection, reconcileNow, prefetchActiveActors } from './core/ws.js';
import { bus } from './core/bus.js';
import { $, state } from './core/state.js';
import { initRouter, goPage } from './core/router.js';
import { getScope } from './core/api.js';
import { initMarked } from './utils/highlight.js';
import { showToast, dismissToast } from './ui/toast.js';
import { renderEvents, updateHeader, updateBusyBar, renderTabBar } from './ui/terminal.js';
import { removeAttachment } from './ui/attachments.js';
import { scrollToBottom, isNearBottom } from './utils/scroll.js';

// ─── 注册所有插件（canvas 按 page 字段过滤挂载）───
import mccTitleStatusPlugin      from './plugins/mcc-title-status.js';
import systemStatusPlugin        from './plugins/system-status.js';
import { newTerminalBtnPlugin }  from './plugins/new-terminal-btn.js';
import { actorGridPlugin }       from './plugins/actor-grid.js';
import { modalCreatePlugin }     from './plugins/modal-create.js';
import historyEntryPlugin        from './plugins/history-entry.js';
import { streamRenderPlugin }    from './plugins/stream-render.js';
import { chatInputPlugin }       from './plugins/chat-input.js';
import { chatToolbarPlugin }     from './plugins/chat-toolbar.js';
import chatShareBtnPlugin         from './plugins/chat-share-btn.js';
import chatActorControls         from './plugins/chat-actor-controls.js';
import chatFilterMine            from './plugins/chat-filter-mine.js';
import actorMentionPlugin        from './plugins/actor-mention.js';
import chatSlashMenu             from './plugins/chat-slash-menu.js';
import projectMapPlugin          from './plugins/project-map.js';
import ctxInspectorPlugin         from './plugins/ctx-inspector.js';

register(mccTitleStatusPlugin);
register(systemStatusPlugin);
register(newTerminalBtnPlugin);
register(actorGridPlugin);
register(modalCreatePlugin);
register(historyEntryPlugin);
register(streamRenderPlugin);
register(chatInputPlugin);
register(chatToolbarPlugin);
register(chatShareBtnPlugin);
register(chatActorControls);
register(chatFilterMine);
register(actorMentionPlugin);
register(chatSlashMenu);
register(projectMapPlugin);
register(ctxInspectorPlugin);

// ─── 库初始化 ───
window.removeAttachment = removeAttachment;
window.__initLibs = function () {
  initMarked();
  if (state.currentPage === 'chat' && state.currentTerminalId) renderEvents();
};
if (typeof marked !== 'undefined') window.__initLibs();

// ─── 全局 Bus 事件 ───
let _reconnectToastEl = null;
bus.on('ws:closed', () => {
  if (!state.wasConnected) return;
  _reconnectToastEl = showToast('连接已断开，重连中…', '', 'warning', { dedupKey: 'ws-reconnect', sticky: true });
});
bus.on('ws:open', () => {
  if (_reconnectToastEl) { dismissToast(_reconnectToastEl); _reconnectToastEl = null; }
});
window.addEventListener('error', (e) => { console.error('Uncaught error:', e.error); });
window.addEventListener('unhandledrejection', (e) => { console.error('Unhandled rejection:', e.reason); });

// ─── 标题点击清缓存 ───
$('#mcc-title')?.addEventListener('click', () => {
  if ('caches' in window) caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))));
  setTimeout(() => location.reload(), 100);
});

// ─── 聊天页初始化（首次进入 chat page 时调用）───
// V1 同款"先渲染缓存再异步刷"：缓存有 events 就立即铺出来（肉眼瞬切），
// 后台 loadActorHistory 拉全量，回来若更全再重渲。避免每次 tab 切换都等一轮 HTTP。
function _initChatPage() {
  if (state.currentPage !== 'chat') return;
  const actorId = state.currentTerminalId;
  if (!actorId) return;
  const t = state.dashboardData.find(t => t.id === actorId);
  if (t) { updateHeader(t); updateBusyBar(t); renderTabBar(); }

  // 1) 同步：缓存有就立刻渲染
  const cachedCount = (state.terminalEvents.get(actorId) || []).length;
  if (cachedCount) {
    renderEvents();
    scrollToBottom('#event-stream');
  }

  // 2) 异步：拉全量历史。10s 内拉过且本地有缓存 → 跳过，避免来回切 tab 反复 HTTP
  const HISTORY_TTL_MS = 10_000;
  const lastFetch = state.lastHistoryFetch.get(actorId) || 0;
  if (cachedCount && Date.now() - lastFetch < HISTORY_TTL_MS) return;

  state.lastHistoryFetch.set(actorId, Date.now());
  loadActorHistory(actorId).then(() => {
    if (state.currentTerminalId !== actorId) return;
    const newCount = (state.terminalEvents.get(actorId) || []).length;
    if (newCount > cachedCount) {
      renderEvents();
      scrollToBottom('#event-stream');
    }
    ensureScrollable(actorId);   // 内容不满一屏 → 自动补加载更早，保证上滑有得可滚
  }).catch(() => {});
}

// ─── 分享链接访客模式探测（纯 UX 收窄；安全边界在后端强制，前端只是别显示越界入口）───
// 后端 /api/scope 返回 { scoped, actorId }。访客 → 打 body.scoped（CSS 隐藏越界 chrome）、
// 记 state.scopedActorId、强制停在自己那个终端的单对话页。全权限会话 scoped=false，零变化。
getScope().then(s => {
  if (!s || !s.scoped || !s.actorId) return;
  state.scopedActorId = s.actorId;
  document.body.classList.add('scoped');
  if (state.currentPage !== 'chat' || state.currentTerminalId !== s.actorId) {
    goPage('chat', { id: s.actorId, replace: true });
  }
  bus.emit('scope:changed');
}).catch(() => {});

// ─── 路由 + WS 初始化 ───
initRouter();   // 设 state.currentPage，切换 DOM active，注册 popstate
connect();      // WS 一次建立，全局共享（幂等）
mount();        // 挂载当前 page 的插件
import('./ui/dashboard.js').then(({ startPinSlotsPolling }) => startPinSlotsPolling());

// ─── actors 加载/重连后初始化聊天 ───
// 无条件绑定：_initChatPage 内部有 `currentPage!=='chat' return` 守卫。
// 关键在于「重连」——WS 半死恢复后 _fetchInitialActors 会重发 actors:loaded，
// 这里据此重跑 _initChatPage 补断线期间错过的消息并重绘（旧版只在「初始即 chat」时绑定，
// 从仪表盘导航进来的终端重连后不补消息 → 表现为「呆呆的、刷新才出」）。
bus.on('actors:loaded', _initChatPage);

// A1: 重连后 _initChatPage 的 loadActorHistory 受 10s TTL 门控（刷屏时可能被跳过，旧诊断项）；
// 这里额外触发一次轻量对账，绕过 TTL 给当前终端立即补洞（reconcileNow 内部近零成本）。
bus.on('actors:loaded', () => reconcileNow());

// B1: actors 就位后，后台并行预取活跃终端首屏（当前终端由 _initChatPage 负责，预取自动跳过），
// 使切过去命中本地缓存、0 次现场首屏 HTTP。低优先、可中断，不阻塞当前终端交互。
bus.on('actors:loaded', () => prefetchActiveActors());

// A1: 周期/触发式对账补回漏帧后重绘当前终端（rebuildTerminalEvents 已刷新 terminalEvents）。
bus.on('actor:reconciled', (actorId) => {
  if (state.currentPage !== 'chat' || actorId !== state.currentTerminalId) return;
  const near = isNearBottom('#event-stream');
  renderEvents();
  if (near) scrollToBottom('#event-stream');
});

// ─── 切页时：卸载 'all' 插件 + 挂载新 page 插件 ───
bus.on('page:change', (newPage) => {
  unmountPage(state.previousPage);
  mount();
  if (newPage === 'chat') {
    // 若 actors 已加载（从 dashboard 跳转），直接初始化
    if (state.actors.size > 0) _initChatPage();
    // else: actors:loaded handler below will fire when WS connects
  }
});

// chat 页内 actor 切换（如 tab 栏点击）→ 重跑初始化（不卸载插件、不切 DOM）
bus.on('terminal:switch', () => {
  if (state.currentPage === 'chat' && state.currentTerminalId) _initChatPage();
});

// ─── 排队消息开始处理 ───
bus.on('msg:started', (msgId) => {
  document.querySelectorAll(`.tl-item[data-msg-id="${msgId}"]`).forEach(el => {
    // CC 拿起该消息：摘掉"排队中"标签（msgId 恒为服务端真实 id）
    el.classList.remove('tl-queued');
    el.querySelector('.tl-queued-pill')?.remove();
  });
});

// ─── chat 页 actor 更新 ───
bus.on('actor:update', (actor) => {
  if (state.currentPage !== 'chat' || actor.id !== state.currentTerminalId) return;
  const t = state.dashboardData.find(t => t.id === actor.id);
  if (t) { updateHeader(t); updateBusyBar(t); renderTabBar(); }
});

// ─── 上滑加载更早历史 ───
const _loadingOlder = new Set();
const _exhaustedOlder = new Set();

// 加载更早一页并重渲，prepend 后锚定视口不跳动。返回新增条数（0=到顶/正在加载）。
async function loadOlderPage(actorId) {
  if (_loadingOlder.has(actorId) || _exhaustedOlder.has(actorId)) return 0;
  _loadingOlder.add(actorId);
  const el = $('#event-stream');
  const prevH = el ? el.scrollHeight : 0;
  try {
    const n = await loadOlderHistory(actorId);
    if (state.currentTerminalId !== actorId) return 0;   // 期间切走了，放弃渲染
    if (n === 0) { _exhaustedOlder.add(actorId); return 0; }
    renderEvents();
    if (el) el.scrollTop = el.scrollHeight - prevH;       // 新内容撑在上方，视口锚定不跳
    return n;
  } finally {
    _loadingOlder.delete(actorId);
  }
}

// 内容撑不满容器时没有滚动条 → 上滑手势无从触发。自动补加载更早，直到可滚动或到顶。
// 防一个终端历史很少时无限拉：最多自动补 5 页（5×200=1000 条足够撑满任何视口）。
async function ensureScrollable(actorId, guard = 5) {
  const el = $('#event-stream');
  if (!el || guard <= 0) return;
  if (state.currentTerminalId !== actorId) return;
  if (el.scrollHeight > el.clientHeight + 40) return;     // 已可滚动，收手
  const n = await loadOlderPage(actorId);
  if (n > 0) ensureScrollable(actorId, guard - 1);        // 还不够满，继续补
}

(function attachScrollLoader() {
  const el = $('#event-stream');
  if (!el) return;
  el.addEventListener('scroll', () => {
    if (state.currentPage !== 'chat' || el.scrollTop > 60) return;
    const actorId = state.currentTerminalId;
    if (actorId) loadOlderPage(actorId);
  }, { passive: true });
})();

// ─── 恢复连接（visibilitychange）───
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  pokeConnection();   // 不信任 readyState：半死 socket 也会被探出并快速重连
  reconcileNow();     // A1: 回前台立即补当前终端可能漏掉的帧（不等 5s 周期）
});
window.addEventListener('focus', () => reconcileNow());   // A1: 窗口获焦同样立即对账
