// terminal.js — 终端聊天主入口（绑定 URL 参数、消息历史、Busy 状态、Tab 栏）

import { $, state, STATUS, BASE_PATH, CHIP_ANIMATION_DELAY_MS } from '../core/state.js';
import { goPage } from '../core/router.js';
import { esc } from '../utils/escape.js';
import { timeNow } from '../utils/time.js';
import { bus } from '../core/bus.js';
import { loadActorHistory } from '../core/ws.js';
import { appendEvent, createStreamingBubble } from './terminal-stream.js';
import { shortProject, shortModel, ctxPct } from './actor-format.js';
import { scrollToBottom, isNearBottom } from '../utils/scroll.js';

// ─── 打开终端页 ───

export function openTerminal(id) {
  goPage('chat', { id });
}

export function goBack() {
  goPage('dashboard');
}

// 删除终端后回 dashboard：用 replaceState 替换当前历史项，避免 forward 残留死链
export function goBackReplace() {
  goPage('dashboard', { replace: true });
}

// ─── 标题栏更新 ───

export function updateHeader(t) {
  $('#term-project').textContent = t.name || shortProject(t.project);
  const badge = $('#term-status');
  badge.textContent = STATUS[t.status] || t.status;
  badge.className = `status-badge status-${t.status}`;
  const modeEl = $('#term-mode');
  const ATYPE_LABEL = { main: '君', aux: '臣', auto: '佐' };
  if (modeEl && t.mode && !t.pinTop && !t.lightweight) {
    if (t.mode === 'advisor') {
      const at = t.advisorType || 'main';
      modeEl.textContent = ATYPE_LABEL[at] || at;
      modeEl.className = `card-mode card-mode-advisor at-${at}`;
      modeEl.dataset.advisorType = at;
      modeEl.style.cursor = 'pointer';
    } else {
      modeEl.textContent = '使'; modeEl.className = 'card-mode card-mode-worker'; modeEl.style.cursor = '';
    }
    modeEl.style.display = '';
  } else if (modeEl) { modeEl.style.display = 'none'; }
  const modelEl = $('#term-model');
  if (modelEl) {
    modelEl.innerHTML = shortModel(t.model, t.provider);
    modelEl.className = 'term-model' + (/opus|sonnet|haiku/i.test(t.model || '') ? '' : ' term-model-3p');
  }
  // CTX 检视器数据源:CC 读 CLI 落盘的 sessionId.jsonl / 抓包;灵读 conversations/ 快照。
  // 其他 kind 无数据源,隐藏徽章免得点出空壳检视器。
  const ctxEl = $('#term-ctx');
  if (ctxEl) {
    const supportsCtx = !t.kind || t.kind === 'cc' || t.kind === 'ling';
    ctxEl.style.display = supportsCtx ? '' : 'none';
    if (supportsCtx) ctxEl.innerHTML = ctxPct(t);
  }
  $('#btn-interrupt').style.display = t.status === 'busy' ? 'flex' : 'none';
  $('#btn-send').style.display = t.status === 'busy' ? 'none' : 'flex';
  $('#input-area').style.display = (t.status === 'cancelled' || t.status === 'failed') ? 'none' : 'flex';
}

// ─── Tab 栏 ───

const TAB_TYPE_ORDER = { main: 1, aux: 2, auto: 3 };
function tabTypeRank(t) { return t.pinTop ? 0 : (TAB_TYPE_ORDER[t.advisorType || 'main'] ?? 1); }

export function renderTabBar() {
  const scroll = $('#tabs-scroll');
  if (!scroll || !state.currentTerminalId) return;
  const active = state.dashboardData.filter(t => t.status !== 'cancelled' && !t.callbackTerminalId);
  const userTurn = (t) => t.status !== 'busy' && t.status !== 'creating';
  const waitingForWorker = new Set(state.dashboardData.filter(t => t.callbackTerminalId && t.status === 'busy').map(t => t.callbackTerminalId));
  active.sort((a, b) => {
    const ar = tabTypeRank(a), br = tabTypeRank(b);
    if (ar !== br) return ar - br;
    if (userTurn(a) !== userTurn(b)) return userTurn(a) ? -1 : 1;
    if (userTurn(a)) {
      const aU = state.unreadTerminals.has(a.id) ? 0 : 1, bU = state.unreadTerminals.has(b.id) ? 0 : 1;
      if (aU !== bU) return aU - bU;
      return a.lastActivityAt - b.lastActivityAt;
    }
    return b.lastActivityAt - a.lastActivityAt;
  });
  let html = '', lastRank = -1;
  for (const t of active) {
    const rank = tabTypeRank(t);
    if (lastRank >= 0 && rank !== lastRank) html += '<div class="tab-sep"></div>';
    lastRank = rank;
    const cur = t.id === state.currentTerminalId;
    const ut = userTurn(t);
    const cls = cur ? 'tab-pill tab-current' : !ut ? 'tab-pill tab-busy' : waitingForWorker.has(t.id) ? 'tab-pill tab-waiting' : 'tab-pill tab-attention';
    const dot = cur ? '' : '<span class="tab-dot"></span>';
    const tabName = t.name || shortProject(t.project);
    html += `<div class="${cls}" data-id="${t.id}" title="${esc(t.project)}">${dot}<span class="tab-name">${esc(tabName)}</span></div>`;
  }
  scroll.innerHTML = html;
}

// ─── 事件流 ───

export function pushEvent(actorId, event) {
  if (['reply','error','interrupted','cancelled','inline_text'].includes(event.action)) {
    const sb = state.streamingBubbles.get(actorId);
    if (sb) { sb.el?.remove(); sb.el = null; state.streamingBubbles.delete(actorId); }
  }
  if (!state.terminalEvents.has(actorId)) state.terminalEvents.set(actorId, []);
  const list = state.terminalEvents.get(actorId);
  list.push(event);
  if (list.length > 500) list.splice(0, list.length - 500);
  if (event.action === 'reply' && state.currentTerminalId !== actorId) state.unreadTerminals.add(actorId);
  if (state.currentTerminalId === actorId) {
    const sel = '#event-stream';
    const near = isNearBottom(sel); appendEvent(event, $(sel)); if (near) scrollToBottom(sel);
  } else {
    // 后台 actor：append 到缓存 fragment，切回时零重建
    const cachedFrag = state.terminalDOM.get(actorId);
    if (cachedFrag) appendEvent(event, cachedFrag);
  }
  renderTabBar();
}

export function renderEvents() {
  const stream = $('#event-stream');
  const prevId = stream._termId;
  if (prevId && prevId !== state.currentTerminalId && stream.children.length) {
    const prevSb = state.streamingBubbles.get(prevId);
    if (prevSb?.el) { prevSb.el.remove(); prevSb.el = null; }
    const frag = document.createDocumentFragment();
    while (stream.firstChild) frag.appendChild(stream.firstChild);
    state.terminalDOM.set(prevId, frag);
  }
  stream._termId = state.currentTerminalId;
  const cached = state.terminalDOM.get(state.currentTerminalId);
  if (cached) {
    const evtCount = (state.terminalEvents.get(state.currentTerminalId) || []).length;
    const domCount = cached.querySelectorAll('.tl-item:not(.tl-streaming)').length;
    if (domCount >= evtCount && domCount > 0) {
      stream.innerHTML = ''; stream.appendChild(cached); state.terminalDOM.delete(state.currentTerminalId); return;
    }
    state.terminalDOM.delete(state.currentTerminalId);
  }
  const frag = document.createDocumentFragment();
  for (const evt of state.terminalEvents.get(state.currentTerminalId) || []) appendEvent(evt, frag);
  stream.innerHTML = ''; stream.appendChild(frag);
}

export function handleStreamChunk(actorId, chunk) {
  let sb = state.streamingBubbles.get(actorId);
  if (!sb) { sb = { text: '', el: null }; state.streamingBubbles.set(actorId, sb); }
  sb.text += chunk;
  if (actorId !== state.currentTerminalId) return;
  const sel = '#event-stream';
  if (!sb.el) { sb.el = createStreamingBubble(sb.text); $(sel).appendChild(sb.el); }
  else { const c = sb.el.querySelector('.tl-content'); if (c) c.textContent += chunk; }
  if (isNearBottom(sel)) scrollToBottom(sel);
}

function attachStreamingBubble() {
  const sb = state.streamingBubbles.get(state.currentTerminalId);
  if (!sb) return;
  sb.el = createStreamingBubble(sb.text);
  const sel = '#event-stream';
  $(sel).appendChild(sb.el); scrollToBottom(sel);
}

// ─── Busy 状态 ───

export function updateBusyBar(t) {
  const bar = $('#busy-bar'), toolEl = $('#busy-tool'), spinner = $('#busy-spinner');
  if (!bar) return;
  if (toolEl) toolEl.textContent = (t.status === 'busy' ? (t.currentTask || t.recentSummary) : t.recentSummary) || '';
  if (spinner) spinner.style.display = t.status === 'busy' ? '' : 'none';
}

// ─── 建议芯片 ───

export function renderSuggestionChips() {
  const c = $('#suggestion-chips');
  if (!c) return;
  if (!state.currentSuggestions.length) { clearSuggestionChips(); return; }
  c.innerHTML = state.currentSuggestions.map((text, i) =>
    `<button class="suggest-chip" data-idx="${i}" style="animation-delay:${i * CHIP_ANIMATION_DELAY_MS}ms">${esc(text)}</button>`
  ).join('');
  c.classList.add('visible');
}

export function clearSuggestionChips() {
  state.currentSuggestions = [];
  for (const id of ['suggestion-chips', 'orch-suggestion-chips', 'chat-suggestion-chips']) {
    const c = $(`#${id}`); if (c) { c.classList.remove('visible'); c.innerHTML = ''; }
  }
}
