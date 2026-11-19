// attach-picker.js — 统一多源文件选择器 overlay（本设备 + 可扩展的远程源）
// 顶部源 tab = [本设备]（纯客户端，触发原生 input）+ 后端 GET /api/sources?context=attach 的远程源。
// 远程源：面包屑下钻浏览（书签→目录）或扁平视图；点文件 → fetch base64 → addRemoteAttachment 进会话。
// 失败：toast + health yellow（不白屏）。加机器=后端注册表加一块 → tab 自动出现。

import { $, BASE_PATH } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { showToast } from './toast.js';
import { addRemoteAttachment } from './attachments.js';

let _health = () => {};
let _onPickLocal = () => {};   // 本设备 tab → 触发原生 file-input（由 chat-input 注入）
export function initAttachPicker({ health, onPickLocal } = {}) {
  if (health) _health = health;
  if (onPickLocal) _onPickLocal = onPickLocal;
}

const ICON = { dir:'📁', file:'📄' };
const fileIcon = (name='') => {
  const e = name.split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','gif','webp','svg'].includes(e)) return '🖼️';
  if (e === 'pdf') return '📕'; if (['doc','docx'].includes(e)) return '📘';
  if (['xls','xlsx','csv'].includes(e)) return '📊'; if (['zip','rar','7z'].includes(e)) return '🗜️';
  if (['mp3','wav','m4a'].includes(e)) return '🎵'; if (['mp4','mov','mkv'].includes(e)) return '🎬';
  return ICON.file;
};
const fmtSize = (n) => n == null ? '' : n < 1024 ? n + 'B' : n < 1048576 ? (n/1024).toFixed(0)+'K' : (n/1048576).toFixed(1)+'M';

const LOCAL_TAB = { id: '__local__', label: '本设备', kind: 'local' };
const _ctx = { open:false, sources:[], srcId:null, stack:[], busy:false };

// ─── 后端 ───
async function _api(label, url) {
  try {
    const r = await fetch(url);
    if (!r.ok) { _fail(`${label} HTTP ${r.status}`); return { error: `HTTP ${r.status}` }; }
    const j = await r.json();
    if (j && j.error) { _fail(`${label}：${j.error}`); return j; }
    _health('green');
    return j;
  } catch (e) { _fail(`${label} ${e.message}`); return { error: e.message }; }
}
function _fail(detail) { showToast('文件选择器', detail, 'warning'); _health('yellow', detail); }

// BASE_PATH：子路径部署（如 https://example.com/mcc）下 fetch 绝对 /api 会丢前缀→403，须前置
const apiSources = () => _api('sources', `${BASE_PATH}/api/sources?context=attach`);
const apiTree    = (id, p) => _api('tree', `${BASE_PATH}/api/sources/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(p || '')}`);
const apiFetch   = (id, p) => _api('fetch', `${BASE_PATH}/api/sources/${encodeURIComponent(id)}/fetch?path=${encodeURIComponent(p)}`);

// ─── DOM ───
function ensureOverlay() {
  let el = document.getElementById('attach-picker-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'attach-picker-overlay';
  el.className = 'ap-overlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="ap-modal">
      <header class="ap-header">
        <span class="ap-title">选择文件</span>
        <button class="ap-close" data-act="close" title="关闭">&times;</button>
      </header>
      <nav class="ap-tabs" data-role="tabs"></nav>
      <div class="ap-crumb" data-role="crumb" hidden></div>
      <div class="ap-body" data-role="body"><div class="ap-empty">加载中…</div></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', _onClick);
  return el;
}

// 注意：不能 async——必须在原始 click 手势内同步触发 file-input，否则浏览器拦截
export function openAttachPicker() {
  const el = ensureOverlay();
  el.hidden = false;
  _ctx.open = true;
  _ctx.stack = [];
  _ctx.srcId = LOCAL_TAB.id;
  _ctx.sources = [LOCAL_TAB];
  renderTabs(_ctx.sources);
  renderLocal();
  _onPickLocal();                     // 本设备默认即拉起系统选择器（手势内同步调用，1 次点击）
  apiSources().then(r => {            // 远程源异步补齐，供切 tab 用
    _ctx.sources = [LOCAL_TAB, ...(Array.isArray(r) ? r : [])];
    renderTabs(_ctx.sources);
  });
}

export function closeAttachPicker() {
  const el = document.getElementById('attach-picker-overlay');
  if (!el) return;
  el.hidden = true;
  _ctx.open = false;
}

function renderTabs(sources) {
  const el = document.getElementById('attach-picker-overlay');
  if (!el) return;
  el.querySelector('[data-role="tabs"]').innerHTML = sources.map(s =>
    `<button class="ap-tab ${s.id === _ctx.srcId ? 'ap-tab-on' : ''}" data-src="${esc(s.id)}">${esc(s.label)}</button>`
  ).join('');
}

function selectSource(id) {
  _ctx.srcId = id;
  _ctx.stack = [];
  renderTabs(_ctx.sources.length ? _ctx.sources : [LOCAL_TAB]);
  if (id === LOCAL_TAB.id) { renderLocal(); _onPickLocal(); return; }   // 选本设备即拉起系统选择器
  loadDir('');
}

function renderLocal() {
  setCrumb(null);
  setBody(`<div class="ap-local">
    <p class="ap-local-tip">已打开系统文件选择器；如未弹出 <button class="ap-local-btn" data-act="local-pick">点此选择</button></p>
  </div>`);
}

// ─── 远程浏览 ───
async function loadDir(path) {
  if (_ctx.busy) return;
  _ctx.busy = true;
  renderCrumb();
  setBody('<div class="ap-empty">加载中…</div>');
  const r = await apiTree(_ctx.srcId, path);
  _ctx.busy = false;
  if (r.error) { setBody(`<div class="ap-empty ap-err">${esc(r.error)}</div>`); return; }
  renderEntries(r.entries || []);
}

function renderEntries(entries) {
  if (!entries.length) { setBody('<div class="ap-empty">（空）</div>'); return; }
  const rows = entries.map((e, i) => {
    const isDir = e.type === 'dir';
    const icon = isDir ? ICON.dir : fileIcon(e.name);
    const meta = isDir ? '' : `<span class="ap-meta">${fmtSize(e.size)}</span>`;
    return `<div class="ap-row" data-idx="${i}" data-type="${e.type}">
      <span class="ap-ic">${icon}</span><span class="ap-nm">${esc(e.name)}</span>${meta}
      <span class="ap-arrow">${isDir ? '›' : ''}</span></div>`;
  }).join('');
  setBody(`<div class="ap-list">${rows}</div>`);
  _ctx._entries = entries;
}

function renderCrumb() {
  const root = _ctx.sources.find(s => s.id === _ctx.srcId)?.label || '';
  const parts = [`<span class="ap-cr" data-depth="-1">${esc(root)}</span>`];
  _ctx.stack.forEach((s, i) => parts.push(`<span class="ap-cr-sep">/</span><span class="ap-cr" data-depth="${i}">${esc(s.label)}</span>`));
  setCrumb(parts.join(''));
}
function setCrumb(html) {
  const el = document.getElementById('attach-picker-overlay');
  const c = el.querySelector('[data-role="crumb"]');
  if (html == null) { c.hidden = true; c.innerHTML = ''; } else { c.hidden = false; c.innerHTML = html; }
}
function setBody(html) { document.getElementById('attach-picker-overlay').querySelector('[data-role="body"]').innerHTML = html; }

// ─── 事件 ───
async function _onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') { closeAttachPicker(); return; }
  if (act === 'local-pick') { closeAttachPicker(); _onPickLocal(); return; }

  const tab = e.target.closest('.ap-tab');
  if (tab) { selectSource(tab.dataset.src); return; }

  const cr = e.target.closest('.ap-cr');
  if (cr) {
    const depth = parseInt(cr.dataset.depth);
    _ctx.stack = depth < 0 ? [] : _ctx.stack.slice(0, depth + 1);
    loadDir(_ctx.stack.length ? _ctx.stack[_ctx.stack.length - 1].path : '');
    return;
  }

  const row = e.target.closest('.ap-row');
  if (!row) return;
  const entry = _ctx._entries?.[parseInt(row.dataset.idx)];
  if (!entry) return;
  if (entry.type === 'dir') {
    _ctx.stack.push({ label: entry.name, path: entry.abspath });
    loadDir(entry.abspath);
  } else {
    pickFile(entry);
  }
}

async function pickFile(entry) {
  if (_ctx.busy) return;
  _ctx.busy = true;
  showToast('文件选择器', `正在取回 ${entry.name}…`, 'info');
  const r = await apiFetch(_ctx.srcId, entry.abspath);
  _ctx.busy = false;
  if (r.error) return;   // _api 已 toast
  if (addRemoteAttachment(r)) {
    showToast('文件选择器', `已添加附件：${entry.name}`, 'success');
    closeAttachPicker();
  }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _ctx.open) closeAttachPicker(); });
