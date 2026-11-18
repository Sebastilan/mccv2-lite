// scroll.js — 滚动工具（scrollToBottom / isNearBottom）

import { $ } from '../core/state.js';

export function scrollToBottom(selector) {
  requestAnimationFrame(() => { const s = $(selector); if (s) s.scrollTop = s.scrollHeight; });
}

export function isNearBottom(selector, threshold = 150) {
  const el = $(selector);
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
}
