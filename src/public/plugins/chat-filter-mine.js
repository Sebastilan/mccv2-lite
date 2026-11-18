// chat-filter-mine.js — 插件：聊天流"只看我的消息"过滤切换（chat.input.toolbar，紧邻 / 按钮）
// 切换 #event-stream 的 .filter-mine class，CSS 负责隐藏 .tl-item:not(.tl-user)（style.css:515）
// 过滤态下点某条我的消息 = 退出过滤 + 跳转到该条（快捷定位）
import { $ } from '../core/state.js';
import { scrollToBottom } from '../utils/scroll.js';

export default {
  id: 'chat-filter-mine',
  slot: 'chat.input.toolbar',
  page: 'chat',
  order: 20,
  _el: null,
  _onStreamClick: null,

  mount(el) {
    this._el = el;
    el.innerHTML = `
      <button class="toolbar-btn" data-action="toggle" title="只看我的消息（过滤中点某条可跳转到上下文）" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </button>
    `;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="toggle"]');
      if (!btn) return;
      const stream = $('#event-stream');
      this._setFilter(!stream?.classList.contains('filter-mine'));
      scrollToBottom('#event-stream');
    });

    this._onStreamClick = (e) => this._handleStreamClick(e);
    $('#event-stream')?.addEventListener('click', this._onStreamClick);
  },

  // 统一改过滤态：class + 按钮外观/aria 保持同步
  _setFilter(on) {
    $('#event-stream')?.classList.toggle('filter-mine', on);
    const btn = this._el?.querySelector('[data-action="toggle"]');
    if (!btn) return;
    btn.classList.toggle('btn-filter-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  },

  // 过滤态下点消息 → 展开全部并定位到这条
  _handleStreamClick(e) {
    const stream = $('#event-stream');
    if (!stream?.classList.contains('filter-mine')) return;
    // 交互元素与划词复制照常
    if (e.target.closest('a, button, input, textarea, select, summary, img')) return;
    if (String(window.getSelection?.() || '').trim()) return;
    const item = e.target.closest('.tl-item.tl-user');
    if (!item) return;

    this._setFilter(false);
    item.classList.add('tl-jump-flash');
    setTimeout(() => item.classList.remove('tl-jump-flash'), 1400);
    // 展开后布局才稳定，等两帧再定位
    requestAnimationFrame(() => requestAnimationFrame(() => {
      stream.scrollTop = Math.max(0, item.offsetTop - 12);
    }));
  },

  unmount() {
    if (this._onStreamClick) $('#event-stream')?.removeEventListener('click', this._onStreamClick);
    this._onStreamClick = null;
    this._el = null;
  },
};
