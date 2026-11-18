// terminal-stream.js — 流式消息渲染（消息事件 → DOM，无状态）

import { $, state, BASE_PATH } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { timeNow } from '../utils/time.js';
import { renderMd, stripCCTags } from '../utils/markdown.js';
import { reviewLinkHtml } from '../utils/review-link.js';
import { askCardHtml } from '../utils/ask-card.js';

const SYSTEM_MSG_PREFIXES = ['[HEARTBEAT_TRIGGER]','[SUMMARY_TRIGGER]','[PATROL_ALERT]','[WORKER_DONE]','[WORKER_FAILED]','[SHARE:','[排队]','[来自 ','Read and execute:','[TAKEOVER_REQUEST:','[TAKEOVER_RELEASED:','[TAKEOVER_EXPIRED:','[TAKEOVER_PREEMPTED:'];
const COLLAPSIBLE_PREFIXES = { '[HEARTBEAT_TRIGGER]': '心跳', '[SUMMARY_TRIGGER]': '摘要', '[PATROL_ALERT]': '巡查', '[WORKER_DONE]': 'Worker完成', '[WORKER_FAILED]': 'Worker失败' };

function stripSystemReminders(text) {
  if (!text || !text.includes('<system-reminder>')) return text;
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

export function appendEvent(ev, parent) {
  const el = document.createElement('div');
  const a = ev.action;
  // thinking 用折叠块渲染，跟实时 stream-render.js 的 appendThinkingBlock 保持一致
  if (a === 'thinking') {
    el.className = 'tl-item plugin-thinking-block';
    el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content"><details class="plugin-thinking-details"><summary class="plugin-thinking-summary">💭 思考过程</summary><div class="plugin-thinking-body">${renderMd(ev.detail || '', BASE_PATH)}</div></details></div>`;
    parent.appendChild(el);
    return;
  }
  // ask_pending：MCP ask_user 工具触发的真问答卡（带 askId，点击 POST /api/ask/:id/answer）
  if (a === 'ask_pending') {
    el.className = 'tl-item tl-reply';
    el.dataset.askId = ev.askId || '';
    el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content">${askCardHtml(ev.askId || '', ev.questions || [])}</div>`;
    parent.appendChild(el);
    return;
  }
  if (a === 'ask_answered') {
    el.className = 'tl-item tl-system';
    el.innerHTML = `<div class="tl-dot dot-status"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content">✓ 已回答：${esc((ev.answers || []).join(' / '))}</div>`;
    parent.appendChild(el);
    return;
  }
  // share kind 渲染为绿色卡片（点击跳 review.html）
  if (a === 'share') {
    const p = ev.payload || {};
    const MODE_ICON = { review: '📄', 'visual-review': '📕', image: '🖼', xlsx: '📊', media: '🎬', download: '📦' };
    const icon = MODE_ICON[p.mode] || '📄';
    const url = `${BASE_PATH}/review.html?token=${encodeURIComponent(p.token || '')}`;
    const sizeStr = !p.size ? '' : p.size < 1024 ? `${p.size} B`
      : p.size < 1024 * 1024 ? `${(p.size / 1024).toFixed(1)} KB`
      : `${(p.size / 1024 / 1024).toFixed(1)} MB`;
    el.className = 'tl-item plugin-share-card';
    el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content"><a class="share-card" href="${url}" target="_blank" rel="noopener"><span class="share-icon">${icon}</span><div class="share-body"><div class="share-name">${esc(p.name || '(unnamed)')}</div><div class="share-meta">${esc(p.mode || '')}${sizeStr ? ' · ' + sizeStr : ''}</div></div><span class="share-action">${p.mode === 'media' ? '点击播放' : '点击进入审阅'}</span></a></div>`;
    parent.appendChild(el);
    return;
  }
  // tool_call 用折叠卡渲染，跟实时 stream-render.js 的 appendToolCallBlock 保持一致
  if (a === 'tool_call') {
    const toolName = ev.toolName || 'tool';
    // AskUserQuestion 渲染为可点击选项卡片（stream-render.js 委托 .ask-option 点击）
    if (toolName === 'AskUserQuestion' && ev.input?.questions?.length) {
      el.className = 'tl-item tl-reply';
      const qs = ev.input.questions.map(q => {
        const opts = (q.options || []).map(o => `<button class="ask-option" type="button">${esc(o.label)}</button>`).join('');
        return `<div class="ask-question">${esc(q.question || '')}</div>${opts ? `<div class="ask-options">${opts}</div>` : ''}`;
      }).join('');
      el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content"><div class="ask-card">${qs}</div></div>`;
      parent.appendChild(el);
      return;
    }
    el.className = 'tl-item plugin-tool-call';
    const callId = ev.callId || '';
    const summary = String(ev.detail || '').slice(0, 120);
    if (callId) el.dataset.callId = callId;
    el.innerHTML = `<div class="tl-dot dot-tool"></div><div class="tl-time">${esc(ev.time)}</div><div class="tl-content"><details class="plugin-tool-details"><summary class="plugin-tool-summary">🔧 <span class="tool-name">${esc(toolName)}</span>${reviewLinkHtml(toolName, ev.input)}</summary>${summary ? `<div class="plugin-tool-args"><code>${esc(summary)}</code></div>` : ''}</details></div>`;
    parent.appendChild(el);
    return;
  }
  const isReply = a === 'reply' || a === 'inline_text';
  const isPlan = a === 'step_plan';
  const isSystemMsg = a === 'user_message' && SYSTEM_MSG_PREFIXES.some(p => (ev.detail || '').startsWith(p));
  const isUser = a === 'user_message' && !isSystemMsg;
  const isErr = a === 'error';
  const isTurnSummary = a === 'turn_summary';
  const isSystem = a === 'system' || isTurnSummary;
  const isStatus = ['created', 'cancelled', 'interrupted', 'rotated'].includes(a);

  let dotCls = 'dot-tool', itemCls = '';
  if (isUser) { dotCls = 'dot-user'; itemCls = 'tl-user'; if (ev.queued) itemCls += ' tl-queued'; }
  else if (isSystemMsg) { dotCls = 'dot-status'; itemCls = 'tl-system'; }
  else if (isReply) { dotCls = 'dot-reply'; itemCls = 'tl-reply'; }
  else if (isErr) { dotCls = 'dot-error'; itemCls = 'tl-error'; }
  else if (isSystem) { dotCls = 'dot-status'; itemCls = 'tl-system'; }
  else if (isStatus) { dotCls = 'dot-status'; }
  else if (isPlan) { dotCls = 'dot-plan'; itemCls = 'tl-plan'; }

  el.className = `tl-item ${itemCls}`;
  const isReadTool = a === 'Read' || a === 'read_file';
  const rvLink = ev.fileId && !isReadTool ? ` <a class="rv-link" href="${BASE_PATH}/review.html?id=${ev.fileId}" target="_blank">审阅</a>` : '';

  const isAsk = a === 'AskUserQuestion';
  let content, imgAbove = '';
  const hasImage = (ev.detail || '').includes('![');

  if (isReply) content = renderMd(stripSystemReminders(ev.detail), BASE_PATH);
  else if (isPlan) content = renderMd(ev.detail, BASE_PATH);
  else if (isUser && hasImage) {
    const imgParts = [], txtParts = [];
    for (const line of (ev.detail || '').split('\n')) {
      const imgMatch = line.match(/!\[[^\]]*\]\([^)]+\)/g);
      if (imgMatch) {
        imgParts.push(...imgMatch);
        const remaining = line.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
        if (remaining) txtParts.push(remaining);
      } else { txtParts.push(line); }
    }
    imgAbove = renderMd(imgParts.join('\n'), BASE_PATH);
    content = txtParts.filter(Boolean).length ? esc(txtParts.join('\n')) : '';
  }
  else if (isUser) content = esc(ev.detail);
  else if (isSystemMsg && (ev.detail || '').startsWith('[TAKEOVER_REQUEST:')) {
    const inner = ev.detail.slice('[TAKEOVER_REQUEST:'.length, -1);
    const c1 = inner.indexOf(':');
    const tkToken = c1 > 0 ? inner.slice(0, c1) : inner;
    const rest = c1 > 0 ? inner.slice(c1 + 1) : '';
    const c2 = rest.indexOf(':');
    const tkMachine = c2 >= 0 ? rest.slice(0, c2) : rest;
    const tkReason = c2 >= 0 ? rest.slice(c2 + 1) : '';
    const tkUrl = `${BASE_PATH}/takeover/${encodeURIComponent(tkToken)}`;
    content = `<div class="takeover-card"><div class="tkv-title">🖐 ${esc(tkMachine)} 需要你接管</div><div class="tkv-sub">${esc(tkReason || '接管请求')}</div><a class="tkv-btn" href="${tkUrl}">进入接管</a></div>`;
  }
  else if (isSystemMsg || isSystem) {
    const collapseLabel = isSystemMsg && Object.entries(COLLAPSIBLE_PREFIXES).find(([p]) => (ev.detail || '').startsWith(p));
    if (collapseLabel) {
      content = `<details class="sys-collapse"><summary>${esc(collapseLabel[1])}</summary>${renderMd(ev.detail, BASE_PATH)}</details>`;
    } else {
      content = renderMd(ev.detail, BASE_PATH) + rvLink;
    }
  }
  else if (isErr) content = `<span class="tl-action">${esc(a)}</span> ${esc(ev.detail)}`;
  else if (isAsk) {
    const lines = (ev.detail || '').split('\n');
    const question = esc(lines[0]);
    const opts = lines[1] ? lines[1].split(' / ').map(o => `<span class="ask-option">${esc(o)}</span>`).join('') : '';
    content = `<div class="ask-card"><div class="ask-question">${question}</div>${opts ? `<div class="ask-options">${opts}</div>` : ''}</div>`;
  }
  else if (isReadTool && ev.fileId && ev.isImage) content = `<span class="tl-action">${esc(a)}</span> <a class="rv-inline img-preview-link" data-img-url="${BASE_PATH}/api/files/${ev.fileId}/image">${esc(ev.detail)}</a>`;
  else if (isReadTool && ev.fileId) content = `<span class="tl-action">${esc(a)}</span> <a class="rv-inline" href="${BASE_PATH}/review.html?id=${ev.fileId}" target="_blank">${esc(ev.detail)}</a>`;
  else content = `<span class="tl-action">${esc(a)}</span> ${esc(ev.detail)}${rvLink}`;

  const msgCopyBtn = (isReply || isUser) ? `<button class="msg-copy-btn" title="复制整段">复制</button>` : '';
  const imgSection = imgAbove ? `<div class="tl-img-above">${imgAbove}</div>` : '';
  const queuedPill = isUser && ev.queued ? `<span class="tl-queued-pill">排队中</span>` : '';
  if (isUser && ev.msgId != null) el.dataset.msgId = ev.msgId;
  el.innerHTML = `<div class="tl-dot ${dotCls}"></div><div class="tl-time">${esc(ev.time)}</div>${queuedPill}${imgSection}${content ? `<div class="tl-content">${msgCopyBtn}${content}</div>` : ''}`;
  const tlContent = el.querySelector('.tl-content');
  if (tlContent && (isReply || isUser)) tlContent.dataset.raw = ev.detail || '';

  if (isTurnSummary) el.classList.add('tl-turn-summary');
  parent.appendChild(el);
}

export function createStreamingBubble(text) {
  const el = document.createElement('div');
  el.className = 'tl-item tl-reply tl-streaming';
  el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(timeNow())}</div><div class="tl-content"></div>`;
  el.querySelector('.tl-content').textContent = text;
  return el;
}
