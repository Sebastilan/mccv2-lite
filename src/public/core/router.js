// router.js — SPA 路由：URL hash → page 切换 + history.pushState + URL hash 解析
import { state } from './state.js';
import { bus } from './bus.js';

export function parseHash() {
  // /#/chat?id=cc_xxx → { page: 'chat', id: 'cc_xxx' }
  // /  or /#/         → { page: 'dashboard' }
  const h = location.hash.slice(2); // strip #/
  if (!h) return { page: 'dashboard' };
  const [path, qs] = h.split('?');
  if (path === 'chat') {
    const params = new URLSearchParams(qs || '');
    return { page: 'chat', id: params.get('id') };
  }
  return { page: 'dashboard' };
}

function _applyDOM(page) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
}

export function goPage(page, opts = {}) {
  const prev = state.currentPage || 'dashboard';
  const prevId = state.currentTerminalId;

  // Update terminal ID if provided
  if (opts.id !== undefined) state.currentTerminalId = opts.id;

  // Update history (only push if actually changing page)
  const hash = page === 'dashboard'
    ? (location.pathname + location.search) // clear hash
    : '#/chat' + (state.currentTerminalId ? '?id=' + encodeURIComponent(state.currentTerminalId) : '');

  if (page === prev && !opts._popstate) {
    // Same page: still update hash (e.g. different terminal)
    history.replaceState(null, '', hash);
    // 同页面内 actor 切换（如 tab 栏快捷切换）→ emit terminal:switch 让监听者重跑初始化
    if (page === 'chat' && opts.id !== undefined && opts.id !== prevId) {
      bus.emit('terminal:switch', opts.id);
    }
    return;
  }

  // opts.replace：替换当前历史项（用于"删除终端后回 dashboard"——避免 forward 残留死链）
  if (opts._popstate || opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);

  state.previousPage = prev;
  state.currentPage = page;
  _applyDOM(page);
  bus.emit('page:change', page);
}

export function initRouter() {
  // Parse initial URL and set state (no event emitted on init)
  const { page, id } = parseHash();
  state.currentPage = page;
  state.previousPage = 'dashboard';
  if (id) state.currentTerminalId = id;
  _applyDOM(page);

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    const parsed = parseHash();
    if (parsed.id !== undefined) state.currentTerminalId = parsed.id;
    const prev = state.currentPage || 'dashboard';
    state.previousPage = prev;
    state.currentPage = parsed.page;
    _applyDOM(parsed.page);
    bus.emit('page:change', parsed.page);
  });
}
