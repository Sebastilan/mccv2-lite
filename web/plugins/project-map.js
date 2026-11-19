// project-map.js — 插件：文件浏览器（输入栏工具栏按钮 + 全屏 overlay）
// 默认只读浏览：树 + 内嵌预览。点击"批注此文件"才跳 review.html 进入批注流程。

import { $, state } from '../core/state.js';
import { renderMd } from '../utils/markdown.js';
import { esc } from '../utils/escape.js';
import { showToast } from '../ui/toast.js';

const MAP_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>`;

const ICON = {
  dir:'📁', js:'📜', mjs:'📜', ts:'📘', json:'📋', md:'📝',
  html:'🌐', css:'🎨', py:'🐍', sh:'⚙️',
  png:'🖼️', jpg:'🖼️', svg:'🖼️', _file:'📄',
};
const fileIcon = (name) => ICON[name.split('.').pop().toLowerCase()] || ICON._file;

const _ctx = {
  open: false,
  sources: [],
  currentSrc: null,
  tree: new Map(),
  expanded: new Map(),
  current: null,        // { srcId, path } 当前预览的文件
};

// canvas 在 mount 时注入 this.health；本地代理供模块函数调用
let _reportHealth = () => {};

// ─── 后端 ────────────────────────────────────────────────────────────────
// 统一 fetch 封装：失败时 toast + health 上报 yellow，便于诊断
async function _api(label, url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) {
      const detail = `${label} HTTP ${r.status}`;
      showToast('项目地图请求失败', detail, 'warning');
      _reportHealth('yellow', detail);
      return { error: detail };
    }
    _reportHealth('green');
    return await r.json();
  } catch (e) {
    const detail = `${label} ${e.message}`;
    showToast('项目地图请求失败', detail, 'warning');
    _reportHealth('yellow', detail);
    return { error: e.message };
  }
}

const fetchSources = (project)      => _api('sources',  `/api/sources?project=${encodeURIComponent(project || '')}`);
const fetchTree    = (srcId, path)  => _api('tree',     `/api/sources/${encodeURIComponent(srcId)}/tree?path=${encodeURIComponent(path || '')}`);
const fetchFile    = (srcId, path)  => _api('file',     `/api/sources/${encodeURIComponent(srcId)}/file?path=${encodeURIComponent(path)}`);
const shareFile    = (srcId, path, fromActor) => _api('share',
  `/api/sources/${encodeURIComponent(srcId)}/share`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, from_actor: fromActor }) }
);

// ─── DOM ─────────────────────────────────────────────────────────────────
function ensureOverlay() {
  let el = document.getElementById('project-map-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'project-map-overlay';
  el.className = 'pm-overlay';
  el.hidden = true;
  el.innerHTML = `
    <header class="pm-header">
      <span class="pm-title">项目地图</span>
      <select class="pm-src-select" data-act="src"></select>
      <span class="pm-path" data-role="path"></span>
      <button class="pm-annotate" data-act="annotate" hidden>批注此文件</button>
      <button class="pm-close" data-act="close" title="关闭">&times;</button>
    </header>
    <div class="pm-body">
      <aside class="pm-tree" data-role="tree"><div class="pm-empty">加载中…</div></aside>
      <main class="pm-detail" data-role="detail">
        <div class="pm-detail-inner" data-role="detail-inner"><div class="pm-empty">选择文件查看</div></div>
      </main>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', _onClick);
  el.addEventListener('change', _onChange);
  return el;
}

async function openOverlay() {
  const el = ensureOverlay();
  el.hidden = false;
  _ctx.open = true;

  const t = state.dashboardData?.find(t => t.id === state.currentTerminalId);
  const projectName = (t?.project || '').split('/').filter(Boolean).pop() || '';
  const r = await fetchSources(projectName);
  _ctx.sources = Array.isArray(r) ? r : [];
  const sel = el.querySelector('[data-act="src"]');
  sel.innerHTML = _ctx.sources.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  _ctx.currentSrc = _ctx.sources[0]?.id || null;
  if (_ctx.currentSrc) { sel.value = _ctx.currentSrc; await loadDir(_ctx.currentSrc, ''); }
}

function closeOverlay() {
  const el = document.getElementById('project-map-overlay');
  if (!el) return;
  el.hidden = true;
  _ctx.open = false;
  _ctx.tree.clear();
  _ctx.expanded.clear();
  _ctx.current = null;
  el.querySelector('[data-role="detail-inner"]').innerHTML = '<div class="pm-empty">选择文件查看</div>';
  el.querySelector('[data-role="path"]').textContent = '';
  el.querySelector('[data-act="annotate"]').hidden = true;
}

// ─── 树 ──────────────────────────────────────────────────────────────────
function getExpanded(srcId) {
  if (!_ctx.expanded.has(srcId)) _ctx.expanded.set(srcId, new Set(['']));
  return _ctx.expanded.get(srcId);
}

async function loadDir(srcId, path) {
  const key = `${srcId}:${path}`;
  if (!_ctx.tree.has(key)) {
    const r = await fetchTree(srcId, path);
    _ctx.tree.set(key, r.error ? { entries: [], err: r.error } : { entries: r.entries || [] });
  }
  renderTree();
}

function renderTree() {
  const el = document.getElementById('project-map-overlay');
  if (!el) return;
  const container = el.querySelector('[data-role="tree"]');
  if (!_ctx.currentSrc) { container.innerHTML = '<div class="pm-empty">无可用源</div>'; return; }
  const exp = getExpanded(_ctx.currentSrc);
  container.innerHTML = renderLevel(_ctx.currentSrc, '', 0, exp) || '<div class="pm-empty">空</div>';
}

function renderLevel(srcId, path, depth, exp) {
  const node = _ctx.tree.get(`${srcId}:${path}`);
  if (!node) return '';
  if (node.err) return `<div class="pm-empty" style="color:#c00">${esc(node.err)}</div>`;
  let html = '';
  for (const e of node.entries) {
    const childPath = path ? `${path}/${e.name}` : e.name;
    const isDir = e.type === 'dir';
    const isExp = isDir && exp.has(childPath);
    const isSel = _ctx.current && _ctx.current.srcId === srcId && _ctx.current.path === childPath;
    const arrow = isDir ? (isExp ? '▼' : '▶') : ' ';
    const icon  = isDir ? ICON.dir : fileIcon(e.name);
    html += `<div class="pm-row ${isSel ? 'pm-sel' : ''}" data-type="${e.type}" data-path="${esc(childPath)}" style="padding-left:${depth * 14 + 6}px">
      <span class="pm-arrow">${arrow}</span><span class="pm-icon">${icon}</span><span class="pm-name">${esc(e.name)}</span>
    </div>`;
    if (isDir && isExp) html += renderLevel(srcId, childPath, depth + 1, exp);
  }
  return html;
}

// ─── 详情（只读预览） ────────────────────────────────────────────────────
function renderDetail(payload) {
  const el = document.getElementById('project-map-overlay');
  const detail = el.querySelector('[data-role="detail-inner"]');
  if (payload.error === 'binary') {
    detail.innerHTML = `<div class="pm-empty">二进制文件（${esc(payload.ext || '')}，${payload.size} 字节），不支持预览</div>`;
    return;
  }
  if (payload.error) { detail.innerHTML = `<div class="pm-empty" style="color:#c00">${esc(payload.error)}</div>`; return; }
  const ext = (payload.ext || '').toLowerCase();
  if (ext === 'md') {
    detail.innerHTML = `<div class="pm-md">${renderMd(payload.content)}</div>`;
    // 移除 renderMd 注入的复制按钮（会逃逸定位盖住关闭按钮，且本场景不需要）
    detail.querySelectorAll('.code-copy-btn').forEach(b => b.remove());
  } else {
    detail.innerHTML = `<pre class="pm-code"><code>${esc(payload.content)}</code></pre>`;
  }
}

// ─── 事件 ────────────────────────────────────────────────────────────────
function _onChange(e) {
  if (e.target.dataset.act === 'src') {
    _ctx.currentSrc = e.target.value;
    _ctx.current = null;
    loadDir(_ctx.currentSrc, '');
    const el = document.getElementById('project-map-overlay');
    el.querySelector('[data-role="detail-inner"]').innerHTML = '<div class="pm-empty">选择文件查看</div>';
    el.querySelector('[data-role="path"]').textContent = '';
    el.querySelector('[data-act="annotate"]').hidden = true;
  }
}

async function _onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') { closeOverlay(); return; }
  if (act === 'annotate') {
    if (!_ctx.current) return;
    const fromActor = state.currentTerminalId || null;
    const r = await shareFile(_ctx.current.srcId, _ctx.current.path, fromActor);
    if (r?.url) { closeOverlay(); location.href = r.url; }
    else showToast('打开批注页失败', r?.error || 'unknown', 'warning');
    return;
  }

  const row = e.target.closest('.pm-row');
  if (!row) return;
  const path = row.dataset.path;
  if (row.dataset.type === 'dir') {
    const exp = getExpanded(_ctx.currentSrc);
    if (exp.has(path)) exp.delete(path); else { exp.add(path); await loadDir(_ctx.currentSrc, path); return; }
    renderTree();
    return;
  }
  // 文件：内嵌预览
  _ctx.current = { srcId: _ctx.currentSrc, path };
  renderTree();
  const el = document.getElementById('project-map-overlay');
  el.querySelector('[data-role="path"]').textContent = path;
  el.querySelector('[data-act="annotate"]').hidden = false;
  const r = await fetchFile(_ctx.currentSrc, path);
  renderDetail(r);
}

// ─── 插件入口 ────────────────────────────────────────────────────────────
export default {
  id: 'project-map',
  slot: 'chat.input.toolbar',
  page: 'chat',
  order: 10,
  mount(el) {
    _reportHealth = (s, m) => this.health?.(s, m);
    el.innerHTML = `<button class="toolbar-btn" data-action="open" title="项目地图">${MAP_ICON}</button>`;
    el.addEventListener('click', (e) => { if (e.target.closest('[data-action="open"]')) openOverlay(); });
    document.addEventListener('keydown', this._esc = (e) => {
      if (e.key === 'Escape' && _ctx.open) closeOverlay();
    });
  },
  unmount() { document.removeEventListener('keydown', this._esc); },
};
