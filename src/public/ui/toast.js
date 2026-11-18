// toast.js — Toast 浮窗（showToast / showPatrolToast / dismissToast）

import { $, MAX_TOAST_COUNT, TOAST_AUTO_DISMISS_MS } from '../core/state.js';
import { esc } from '../utils/escape.js';

const ALERT_LABELS = { stale: 'Worker 疑似卡死', unhandled_failure: 'Worker 异常未处理', orphan: '孤儿 Worker', healed: '已恢复', heal_failed: '恢复失败', context_warning: '上下文预警' };
const ALERT_STYLE = { stale: 'warning', unhandled_failure: 'danger', orphan: 'warning', healed: 'success', heal_failed: 'danger', context_warning: 'warning' };
const ALERT_ICON = { stale: '⏱', unhandled_failure: '⚠', orphan: '🔗', healed: '✅', heal_failed: '❌', context_warning: '📊' };

export function showToast(title, detail = '', style = 'warning', opts = {}) {
  const container = $('#toast-container');
  if (!container) return;
  const { dedupKey, sticky } = opts;
  if (dedupKey) {
    const existing = container.querySelector(`[data-toast-key="${dedupKey}"]`);
    if (existing) return existing;
  }
  const icons = { warning: '⚠', danger: '❌', success: '✅', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${style}`;
  if (dedupKey) el.dataset.toastKey = dedupKey;
  const detailHtml = detail ? `<div class="toast-detail">${esc(detail)}</div>` : '';
  el.innerHTML = `<span class="toast-icon">${icons[style] || '⚠'}</span><div class="toast-body"><div class="toast-title">${esc(title)}</div>${detailHtml}</div>`;
  el.addEventListener('click', () => dismissToast(el));
  container.appendChild(el);
  while (container.children.length > MAX_TOAST_COUNT) dismissToast(container.firstChild);
  if (!sticky) setTimeout(() => dismissToast(el), TOAST_AUTO_DISMISS_MS);
  return el;
}

export function showPatrolToast(msg) {
  const style = ALERT_STYLE[msg.alertType] || 'warning';
  const icon = ALERT_ICON[msg.alertType] || '⚠';
  const label = ALERT_LABELS[msg.alertType] || msg.alertType;
  const project = msg.project ? ` (${esc(msg.project)})` : '';
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${style}`;
  el.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-body"><div class="toast-title">${esc(label)}${project}</div><div class="toast-detail">${esc(msg.detail || '')}</div></div>`;
  el.addEventListener('click', () => dismissToast(el));
  container.appendChild(el);
  while (container.children.length > MAX_TOAST_COUNT) dismissToast(container.firstChild);
  setTimeout(() => dismissToast(el), TOAST_AUTO_DISMISS_MS);
}

export function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('removing');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}
