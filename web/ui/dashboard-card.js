// dashboard-card.js — 单 actor 卡片渲染（actor → 视图模型一次性映射，无业务逻辑）

import { esc } from '../utils/escape.js';
import { timeAgo } from '../utils/time.js';
import { shortProject, shortModel, ctxPct, shortCost, shortTokens } from './actor-format.js';

const STATUS_LABEL = { creating: '创建中', idle: '空闲', busy: '执行中', cancelled: '已关闭', failed: '异常' };
const ADVISOR_TYPE_LABEL = { main: '君', aux: '臣', auto: '佐' };

export function statusBadgeHtml(t, waitingSet = new Set()) {
  if (t.status === 'idle' && waitingSet.has(t.id)) {
    return `<span class="status-badge status-waiting-worker">等使</span>`;
  }
  return `<span class="status-badge status-${t.status}">${STATUS_LABEL[t.status] || t.status}</span>`;
}

export function termCard(t, renameable = false, waitingSet = new Set()) {
  const displayName = t.name || shortProject(t.project);
  const ownerTag = t.owner && t.owner !== '用户' ? `<span class="card-owner">${esc(t.owner)}</span>` : '';
  const nameClass = renameable ? 'card-project card-project-name' : 'card-project';
  const typeTag = !t.callbackTerminalId && !t.pinTop
    ? `<span class="card-type" data-atype="${t.id}">${ADVISOR_TYPE_LABEL[t.advisorType || 'main'] || t.advisorType}</span>` : '';
  const lockBtn = !t.pinTop && !t.callbackTerminalId
    ? `<span class="card-lock${t.locked ? ' locked' : ''}" data-lock="${t.id}" title="${t.locked ? '解锁' : '锁定'}"></span>` : '';
  const cardClass = t.pinTop ? 'term-card pinned' : 'term-card';
  // 顶置槽（慢聊/灵）是单例展示位，多开靠卡片角标 + —— 不走新建弹窗，点了直接建同 kind 新 actor
  const spawnBtn = t.pinTop && (t.kind === 'chat' || t.kind === 'ling')
    ? `<span class="card-spawn" data-spawn-kind="${t.kind}" title="新建一个${t.kind === 'chat' ? '慢聊' : '灵'}">+</span>` : '';
  return `<div class="${cardClass}" data-id="${t.id}">
    <div class="card-top">
      <span class="${nameClass}">${esc(displayName)}</span>${ownerTag}${typeTag}${lockBtn}
      ${statusBadgeHtml(t, waitingSet)}
    </div>
    <div class="card-subtitle">${esc(t.recentSummary || t.lastUserMessage || t.task || '等待输入...')}</div>
    <div class="card-meta"><span>${shortModel(t.model, t.provider)}</span><span>${ctxPct(t)}</span>${shortCost(t) ? `<span>${shortCost(t)}</span>` : ''}${shortTokens(t) ? `<span>${shortTokens(t)}</span>` : ''}<span>${timeAgo(t.lastActivityAt)}</span></div>
    ${spawnBtn}
  </div>`;
}

// ghost 占位卡：pinSlot 注册但对应 actor 不存在时渲染。点击 → 用 spawnMeta 创建。
export function ghostCard(slot) {
  return `<div class="term-card pinned ghost" data-slot="${esc(slot.id)}">
    <div class="card-top">
      <span class="card-project">${esc(slot.label)}</span>
      <span class="status-badge status-ghost">创建</span>
    </div>
    <div class="card-subtitle">点击创建</div>
  </div>`;
}

export function patchCard(cardEl, t, waitingSet = new Set()) {
  const badge = cardEl.querySelector('.status-badge');
  const isWaiting = t.status === 'idle' && waitingSet.has(t.id);
  const newStatus = isWaiting ? '等使' : (STATUS_LABEL[t.status] || t.status);
  const newCls = isWaiting ? 'status-badge status-waiting-worker' : `status-badge status-${t.status}`;
  if (badge.textContent !== newStatus) badge.textContent = newStatus;
  if (badge.className !== newCls) badge.className = newCls;
  const subtitle = cardEl.querySelector('.card-subtitle');
  const newSub = esc(t.recentSummary || t.lastUserMessage || t.task || '等待输入...');
  if (subtitle.innerHTML !== newSub) subtitle.innerHTML = newSub;
  const ownerEl = cardEl.querySelector('.card-owner');
  const newOwner = t.owner && t.owner !== '用户' ? t.owner : '';
  if (ownerEl && !newOwner) ownerEl.remove();
  else if (ownerEl && ownerEl.textContent !== newOwner) ownerEl.textContent = newOwner;
  else if (!ownerEl && newOwner) {
    const span = document.createElement('span');
    span.className = 'card-owner'; span.textContent = newOwner;
    cardEl.querySelector('.card-project')?.after(span);
  }
  const typeEl = cardEl.querySelector('.card-type');
  if (typeEl) {
    const newLabel = ADVISOR_TYPE_LABEL[t.advisorType || 'main'] || t.advisorType;
    if (typeEl.textContent !== newLabel) typeEl.textContent = newLabel;
  }
  const lockEl = cardEl.querySelector('.card-lock');
  if (lockEl) lockEl.classList.toggle('locked', !!t.locked);
  const metaEl = cardEl.querySelector('.card-meta');
  if (metaEl) {
    const cost = shortCost(t);
    const tok = shortTokens(t);
    const newHtml = `<span>${shortModel(t.model, t.provider)}</span><span>${ctxPct(t)}</span>${cost ? `<span>${cost}</span>` : ''}${tok ? `<span>${tok}</span>` : ''}<span>${timeAgo(t.lastActivityAt)}</span>`;
    if (metaEl.innerHTML !== newHtml) metaEl.innerHTML = newHtml;
  }
}
