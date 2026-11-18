// canvas/index.js — 画布：槽位注册 + 插件挂载 + 健康监控（Phase 5.9 Error Boundary）
import { SLOT_DEFS } from './slots.js';
import { state } from '../core/state.js';

const _plugins = [];
const _mountedContainers = new Map(); // plugin.id → { wrap?, cap }

// ── 健康系统 ─────────────────────────────────────────────────────────────
const _health  = new Map();    // id → { state:'yellow', message, ts }
const _cbs     = new Set();    // onHealthChange 订阅者
let   _postTimer = null;       // 100ms 节流 POST
let   _serverAggregate = 'green';  // 服务端聚合状态（10s 轮询拉取）
let   _serverServices  = {};        // 服务端 services 明细，供主板展开看

function _worst(a, b) {
  const rank = { green: 0, yellow: 1, red: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function _snap() {
  const plugins = {};
  for (const [id, v] of _health.entries()) plugins[id] = v;
  const front = _health.size === 0 ? 'green' : 'yellow';
  return {
    aggregate: _worst(front, _serverAggregate),
    plugins,
    services: _serverServices,
    ts: Date.now(),
  };
}

function _notify() {
  const s = _snap();
  for (const cb of _cbs) cb(s);
}

function _schedulePost() {
  if (_postTimer) clearTimeout(_postTimer);
  _postTimer = setTimeout(() => {
    _postTimer = null;
    fetch('/api/plugins/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_snap()),
    }).catch(e => console.error('[canvas] health POST failed:', e.message));
  }, 100);
}

function _report(id, state, message) {
  let changed = false;
  if (state === 'green') {
    if (_health.has(id)) { _health.delete(id); changed = true; }
    // green + not in map → no-op (nothing to report)
  } else {
    // yellow → always set (update message/ts)
    _health.set(id, { state: 'yellow', message: message || '', ts: Date.now() });
    changed = true;
  }
  if (changed) { _notify(); _schedulePost(); }
}

// 全局 unhandledrejection → 尝试关联到 plugin id
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    const stack = e.reason?.stack || '';
    const m = stack.match(/\/plugins\/([^/.]+)\.js/);
    const id = m ? m[1] : '__unknown__';
    _report(id, 'yellow', String(e.reason?.message || e.reason || 'unhandled rejection'));
  });

  // 10s 轮询拉取服务端聚合状态（cc-pool / ling / recent-summarizer 等服务的黄/红）
  setInterval(async () => {
    try {
      const r = await fetch('/api/plugins/health');
      if (!r.ok) return;
      const j = await r.json();
      const nextAgg  = j.aggregate || 'green';
      const nextSvcs = j.services  || {};
      const aggChanged = nextAgg !== _serverAggregate;
      const svcChanged = JSON.stringify(nextSvcs) !== JSON.stringify(_serverServices);
      if (aggChanged || svcChanged) {
        _serverAggregate = nextAgg;
        _serverServices  = nextSvcs;
        _notify();
      }
    } catch (_) { /* 网络抖动忽略 */ }
  }, 10000);
}

// ── 公开 API ─────────────────────────────────────────────────────────────

/**
 * 注册一个插件。
 * plugin = { id, slot, order?, mount(el), unmount() }
 */
export function register(plugin) {
  if (!plugin?.id)    throw new Error('[canvas] plugin must have an id');
  if (!plugin?.slot)  throw new Error(`[canvas] plugin ${plugin.id} must declare a slot`);
  if (!plugin?.mount) throw new Error(`[canvas] plugin ${plugin.id} must implement mount()`);
  _plugins.push(plugin);
}

/**
 * 按 order 排序后依次 mount 已注册插件（按 currentPage 过滤）。
 * - page-specific 插件：首次 mount 后不再 unmount（留在隐藏 DOM 中）
 * - page:'all' 插件：每次切页时 unmount + remount 到新页的 DOM
 * - 每个插件分配独立 DOM 容器（data-plugin-id 标记，供 DevTools 定位）
 * - mount 失败只隔离本插件，不影响其他
 */
export function mount() {
  const currentPage = state.currentPage || 'dashboard';
  const pageRoot = document.getElementById('page-' + currentPage) || document.documentElement;
  const sorted = [..._plugins].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  for (const p of sorted) {
    // Page filter
    const targetPage = p.page || 'all';
    if (targetPage !== 'all' && targetPage !== currentPage) continue;

    // Skip already-mounted (page-specific plugins stay mounted; 'all' plugins cleared by unmountPage)
    if (_mountedContainers.has(p.id)) continue;

    const def = SLOT_DEFS[p.slot];
    if (!def) {
      console.warn(`[canvas] unknown slot "${p.slot}" for plugin "${p.id}"`);
      continue;
    }
    // app.* 是全局槽位（modal/toast/header 等跨页 DOM），不限定在 page 内查找
    // 其它（dashboard.* / chat.*）槽位限定 pageRoot 以处理跨页同 id 的情况
    const root = p.slot.startsWith('app.') ? document : pageRoot;
    const slotEl = root.querySelector(def.sel);
    if (!slotEl) {
      console.warn(`[canvas] slot "${p.slot}" DOM not found (sel: ${def.sel}) — plugin "${p.id}" skipped`);
      continue;
    }

    // 分配 DOM 容器：cap=one 直接用 slotEl；cap=many 用 display:contents 包装
    let el;
    if (def.cap === 'one') {
      slotEl.dataset.pluginId = p.id;
      el = slotEl;
      _mountedContainers.set(p.id, { cap: 'one' });
    } else {
      const wrap = document.createElement('div');
      wrap.dataset.pluginId = p.id;
      wrap.style.display = 'contents';
      slotEl.appendChild(wrap);
      el = wrap;
      _mountedContainers.set(p.id, { cap: 'many', wrap });
    }

    // 注入 health 报告器
    p.health = (s, message) => _report(p.id, s, message);

    try {
      p.mount(el);
      _report(p.id, 'green');
    } catch (err) {
      console.error(`[canvas] plugin "${p.id}" mount failed:`, err);
      _report(p.id, 'yellow', err.message);
    }
  }
  // Always sync final state to server after all mounts (resets stale file from previous session)
  _schedulePost();
}

/** 卸载 page:'all' 插件（切页时调用），page-specific 插件保持挂载在隐藏 DOM 中。 */
export function unmountPage(_oldPage) {
  for (const p of _plugins) {
    if ((p.page || 'all') !== 'all') continue; // only unmount 'all' plugins
    try { p.unmount?.(); } catch (e) { console.warn(`[canvas] unmount ${p.id}:`, e); }
    const entry = _mountedContainers.get(p.id);
    if (entry?.cap === 'many' && entry.wrap?.parentNode) entry.wrap.parentNode.removeChild(entry.wrap);
    _mountedContainers.delete(p.id);
  }
}

/** 卸载所有插件（HMR 用）。 */
export function unmountAll() {
  for (const p of _plugins) { try { p.unmount?.(); } catch (_) {} }
  _plugins.length = 0;
  _mountedContainers.clear();
}

/** 返回已注册插件快照（只读）。 */
export function listPlugins() {
  return [..._plugins];
}

/** 当前健康快照。 */
export function getHealth() {
  return _snap();
}

/** 订阅健康变更。返回取消订阅函数。 */
export function onHealthChange(cb) {
  _cbs.add(cb);
  return () => _cbs.delete(cb);
}

/** 插件主动上报健康（如后台轮询失败时调）。 */
export function report(id, state, message) {
  _report(id, state, message);
}
