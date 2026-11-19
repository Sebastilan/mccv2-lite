// actor-mention.js — 插件：@ 按钮 + actor picker（chat.input.toolbar）
// 点击按钮 → 弹 popover 列出所有 actor → 选中插入 `@<name> ` 到光标位置
// 同时把 {actor_id, name, token} push 到 state.pendingMentions，sendMsg 消费后组装 meta.mentions
import { $, state, STATUS } from '../core/state.js';
import { esc } from '../utils/escape.js';

let popoverEl = null;
let buttonEl  = null;

function closePopover() {
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
  document.removeEventListener('click', onDocClick, true);
}

function onDocClick(e) {
  if (!popoverEl) return;
  if (popoverEl.contains(e.target) || buttonEl.contains(e.target)) return;
  closePopover();
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  const v = input.value;
  input.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function pickActor(actor_id, name) {
  const token = `@${name}`;
  // 同一 token 已存在不重复入栈（用户可能多次 @ 同一人）
  if (!state.pendingMentions.some(m => m.actor_id === actor_id && m.token === token)) {
    state.pendingMentions.push({ actor_id, name, token });
  }
  const input = $('#msg-input');
  if (input) insertAtCursor(input, token + ' ');
  closePopover();
}

function renderPopover() {
  const list = (state.dashboardData || []).filter(t =>
    t.id !== state.currentTerminalId &&
    t.status !== 'cancelled' && t.status !== 'failed' && t.status !== 'gone'
  );

  const pop = document.createElement('div');
  pop.className = 'mention-popover';
  if (!list.length) {
    pop.innerHTML = '<div class="mp-empty">没有可引用的终端</div>';
  } else {
    pop.innerHTML = '<div class="mp-section">插入引用</div>' + list.map(t => {
      const name = t.name || t.project || t.id;
      const icon = t.status === 'busy' ? '🔄' : '💬';
      return `<div class="mp-item" data-id="${esc(t.id)}" data-name="${esc(name)}">
        <span class="mp-icon">${icon}</span>
        <span class="mp-name">${esc(name)}</span>
        <span class="mp-desc">${esc(STATUS[t.status] || t.status)}</span>
      </div>`;
    }).join('');
    pop.addEventListener('click', (e) => {
      const item = e.target.closest('.mp-item');
      if (!item) return;
      pickActor(item.dataset.id, item.dataset.name);
    });
  }
  return pop;
}

function togglePopover() {
  if (popoverEl) { closePopover(); return; }
  popoverEl = renderPopover();
  // 位置：相对 buttonEl，向上展开（输入区在底部）
  const rect = buttonEl.getBoundingClientRect();
  popoverEl.style.position = 'fixed';
  popoverEl.style.left = `${rect.left}px`;
  popoverEl.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  popoverEl.style.zIndex = '1000';
  document.body.appendChild(popoverEl);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

export default {
  id: 'actor-mention',
  slot: 'chat.input.toolbar',
  page: 'chat',
  order: 10,  // 排在 chat-filter-mine(20) 之前
  _el: null,

  mount(el) {
    this._el = el;
    el.innerHTML = `
      <button class="toolbar-btn" data-action="mention" title="引用其他终端（@）" aria-label="提及终端">
        <span style="font-weight:600;font-size:15px;line-height:1;">@</span>
      </button>
    `;
    buttonEl = el.querySelector('[data-action="mention"]');
    buttonEl.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(); });
  },

  unmount() {
    closePopover();
    buttonEl = null;
    this._el = null;
  },
};
