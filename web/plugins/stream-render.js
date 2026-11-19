// stream-render.js — 插件：消息流渲染 v2（thinking折叠/tool友好渲染/markdown/KaTeX/代码块复制）
import { bus } from '../core/bus.js';
import { $, state, msgToEvent, BASE_PATH } from '../core/state.js';
import { appendEvent } from '../ui/terminal-stream.js';
import { updateHeader, updateBusyBar, renderTabBar, renderSuggestionChips, clearSuggestionChips } from '../ui/terminal.js';
import { sendMessage } from '../core/api.js';
import { renderMd } from '../utils/markdown.js';
import { esc } from '../utils/escape.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { reviewLinkHtml } from '../utils/review-link.js';

// ask_user 卡片辅助：收集每组选中项 / 锁定卡片 / 回传答案
function postAskAnswer(askId, answers) {
  fetch(`${BASE_PATH}/api/ask/${encodeURIComponent(askId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  }).catch(err => console.warn('[stream-render] ask answer:', err));
}
function lockAskCard(card) {
  card.dataset.answered = '1';
  card.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
  const btn = card.querySelector('.ask-submit');
  if (btn) { btn.disabled = true; btn.textContent = '已提交'; }
}
// 每组选中项 → answers[i]（多选 join），全组选完返回数组，否则 null
function collectAskAnswers(card) {
  const groups = [...card.querySelectorAll('.ask-group')];
  const answers = groups.map(g => [...g.querySelectorAll('.ask-option-selected')].map(b => b.dataset.label).join(', '));
  return answers.every(a => a) ? answers : null;
}

function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'img-lightbox';
  lb.innerHTML = `<img src="${src}">`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

function tsToTime(ts) {
  return new Date(ts || Date.now()).toTimeString().substring(0, 8);
}


// 思考流式增量：找/建该 actor 的「思考中…」块，累积 raw 后增量渲染。返回块元素。
function ensureStreamingThink(streamEl, actorId) {
  let el = streamEl.querySelector(`.plugin-thinking-streaming[data-actor="${CSS.escape(actorId)}"]`);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'tl-item plugin-thinking-block plugin-thinking-streaming';
  el.dataset.actor = actorId;
  el.dataset.raw = '';
  el.innerHTML = `
    <div class="tl-dot dot-reply"></div>
    <div class="tl-time">${esc(tsToTime(Date.now()))}</div>
    <div class="tl-content">
      <details class="plugin-thinking-details" open>
        <summary class="plugin-thinking-summary">💭 思考中…</summary>
        <div class="plugin-thinking-body"></div>
      </details>
    </div>`;
  streamEl.appendChild(el);
  return el;
}

// 思考流式块「转正」：完整 thinking 块到达（或 turn_done 兜底）时定稿，避免重复 + 不闪。
// fullText 优先用完整块权威全文，缺省回落累积的 raw。返回 true 表示存在流式块并已转正。
function finalizeStreamingThink(streamEl, actorId, fullText) {
  const el = streamEl.querySelector(`.plugin-thinking-streaming[data-actor="${CSS.escape(actorId)}"]`);
  if (!el) return false;
  el.classList.remove('plugin-thinking-streaming');
  delete el.dataset.actor;
  const text = (fullText && fullText.trim()) ? fullText : (el.dataset.raw || '');
  if (!text.trim()) { el.remove(); return true; }  // 空思考块直接撤掉
  const sum = el.querySelector('.plugin-thinking-summary');
  if (sum) sum.textContent = '💭 思考过程';
  const det = el.querySelector('.plugin-thinking-details');
  if (det) det.open = false;            // 思考结束默认折叠，和历史块一致
  const body = el.querySelector('.plugin-thinking-body');
  if (body) body.innerHTML = renderMd(text);
  return true;
}

function appendThinkingBlock(msg, parent) {
  const content = msg.payload?.thinking || '';
  if (!content.trim()) return;  // 空思考（如心跳沉默轮）不画块，避免一堆空白"思考过程"
  const el = document.createElement('div');
  el.className = 'tl-item plugin-thinking-block';
  el.innerHTML = `
    <div class="tl-dot dot-reply"></div>
    <div class="tl-time">${esc(tsToTime(msg.ts))}</div>
    <div class="tl-content">
      <details class="plugin-thinking-details">
        <summary class="plugin-thinking-summary">💭 思考过程</summary>
        <div class="plugin-thinking-body">${renderMd(content)}</div>
      </details>
    </div>`;
  parent.appendChild(el);
}

// v2 stdio v1 协议：reasoning event 含 subtype（thinking / intent / 未来 plan/critique）
// 统一走折叠 UI，按 subtype 区分图标。subtype 未识别时通用兜底为"🧠 推理"
const REASONING_HEADERS = {
  thinking: '💭 思考过程',
  intent: '🎯 复盘 + 计划',
};
function appendReasoningBlock(msg, parent) {
  const p = msg.payload || {};
  const subtype = p.subtype || 'unknown';
  const content = p.text || '';
  if (!content.trim()) return;  // 空 reasoning 同样不画块
  const el = document.createElement('div');
  el.className = 'tl-item plugin-thinking-block';
  const header = REASONING_HEADERS[subtype] || `🧠 推理 · ${subtype}`;
  el.innerHTML = `
    <div class="tl-dot dot-reply"></div>
    <div class="tl-time">${esc(tsToTime(msg.ts))}</div>
    <div class="tl-content">
      <details class="plugin-thinking-details" data-reasoning-subtype="${esc(subtype)}">
        <summary class="plugin-thinking-summary">${header}</summary>
        <div class="plugin-thinking-body">${renderMd(content)}</div>
      </details>
    </div>`;
  parent.appendChild(el);
}

function appendToolCallBlock(msg, parent) {
  const el = document.createElement('div');
  const p = msg.payload || {};
  const toolName = p.name || p.type || 'tool';
  const callId = p.id || '';
  const input = p.input || {};
  // mcp__mcc__ask_user 的真卡片由 ask_pending event 渲染，这里跳过避免重复
  if (toolName === 'mcp__mcc__ask_user') return;
  // 旧 AskUserQuestion 兜底（理论上已 --disallowed-tools 禁掉，留作 fallback）
  if (toolName === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
    el.className = 'tl-item tl-reply';
    const qs = input.questions.map(q => {
      const opts = (q.options || []).map(o => `<button class="ask-option" type="button">${esc(o.label)}</button>`).join('');
      return `<div class="ask-question">${esc(q.question || '')}</div>${opts ? `<div class="ask-options">${opts}</div>` : ''}`;
    }).join('');
    el.innerHTML = `<div class="tl-dot dot-reply"></div><div class="tl-time">${esc(tsToTime(msg.ts))}</div><div class="tl-content"><div class="ask-card">${qs}</div></div>`;
    parent.appendChild(el);
    return;
  }
  el.className = 'tl-item plugin-tool-call';
  const argText = input.command || input.file_path || input.description ||
    (typeof input === 'string' ? input : Object.keys(input).length ? JSON.stringify(input) : '');
  const summary = String(argText).slice(0, 120);
  if (callId) el.dataset.callId = callId;
  el.innerHTML = `
    <div class="tl-dot dot-tool"></div>
    <div class="tl-time">${esc(tsToTime(msg.ts))}</div>
    <div class="tl-content">
      <details class="plugin-tool-details">
        <summary class="plugin-tool-summary">🔧 <span class="tool-name">${esc(toolName)}</span>${reviewLinkHtml(toolName, input)}</summary>
        ${summary ? `<div class="plugin-tool-args"><code>${esc(summary)}</code></div>` : ''}
      </details>
    </div>`;
  parent.appendChild(el);
}

export const streamRenderPlugin = {
  id: 'stream-render',
  slot: 'chat.messages',
  page: 'chat',
  order: 10,

  _el: null,
  _msgHandler: null,
  _deltaHandler: null,
  _clickHandler: null,

  mount(el) {
    this._el = el;

    this._msgHandler = (msg) => {
      const actorId = msg.from_id === state.selfId ? msg.to_id : msg.from_id;
      if (state.currentTerminalId !== actorId) return;

      const sel = '#event-stream';
      const streamEl = $(sel);
      if (!streamEl) return;
      const near = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 80;

      // v2: thinking → 折叠块（CC 老路径）。若有进行中的流式块，转正复用（不重复、不闪）
      if (msg.kind === 'event' && msg.payload?.event_type === 'thinking') {
        if (!finalizeStreamingThink(streamEl, actorId, msg.payload?.thinking)) {
          appendThinkingBlock(msg, streamEl);
        }
        if (near) streamEl.scrollTop = streamEl.scrollHeight;
        renderTabBar();
        return;
      }

      // stdio v1: reasoning → 折叠块（thinking/intent 共用 UI，subtype 区分图标）
      if (msg.kind === 'event' && msg.payload?.event_type === 'reasoning') {
        appendReasoningBlock(msg, streamEl);
        if (near) streamEl.scrollTop = streamEl.scrollHeight;
        renderTabBar();
        return;
      }

      // tool_purpose 已停用（2026-10-01）：历史事件静默吞掉，不渲染
      if (msg.kind === 'event' && msg.payload?.event_type === 'tool_purpose') return;

      // v2: tool_call → 友好卡片
      if (msg.kind === 'tool_call') {
        appendToolCallBlock(msg, streamEl);
        if (near) streamEl.scrollTop = streamEl.scrollHeight;
        renderTabBar();
        return;
      }

      // 其余事件走 v1 appendEvent（reply/user/system/error 等）
      const evt = msgToEvent(msg);
      if (evt) {
        if (['reply', 'error', 'interrupted', 'cancelled', 'inline_text'].includes(evt.action)) {
          const sb = state.streamingBubbles.get(actorId);
          if (sb?.el) { sb.el.remove(); sb.el = null; state.streamingBubbles.delete(actorId); }
        }
        appendEvent(evt, streamEl);
        if (near) streamEl.scrollTop = streamEl.scrollHeight;
      }

      if (msg.kind === 'event' && msg.payload?.event_type === 'turn_done') {
        finalizeStreamingThink(streamEl, actorId);  // 兜底：思考有增量但未收到完整块时定稿，不卡在"思考中…"
        const t = state.dashboardData.find(t => t.id === actorId);
        if (t) { updateHeader(t); updateBusyBar(t); }
        const suggestions = msg.payload?.suggestions;
        if (suggestions?.length) { state.currentSuggestions = suggestions; renderSuggestionChips(); }
      }
      renderTabBar();
    };

    bus.on('message:new', this._msgHandler);

    // 思考流式增量（瞬时旁路，不落库）：实时追加到「思考中…」块
    this._deltaHandler = (msg) => {
      if (msg.subtype !== 'thinking') return;
      const actorId = msg.actorId;
      if (state.currentTerminalId !== actorId) return;  // 只渲染当前打开的终端
      const streamEl = $('#event-stream');
      if (!streamEl) return;
      const near = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 80;
      const el = ensureStreamingThink(streamEl, actorId);
      el.dataset.raw += msg.text || '';
      const body = el.querySelector('.plugin-thinking-body');
      if (body) body.innerHTML = renderMd(el.dataset.raw);
      if (near) streamEl.scrollTop = streamEl.scrollHeight;
    };
    bus.on('stream:delta', this._deltaHandler);

    this._clickHandler = (e) => {
      const rv = e.target.closest('.rv-link[data-rv-path]');
      if (rv) {
        e.preventDefault();
        e.stopPropagation(); // 防止触发 <summary> 折叠/展开
        const path = rv.dataset.rvPath;
        fetch(`${BASE_PATH}/api/review/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, from_actor: state.currentTerminalId }),
        }).then(r => r.json()).then(d => {
          if (d.url) window.open(`${BASE_PATH}${d.url}`, '_blank');
          else console.warn('[review] share failed:', d);
        }).catch(err => console.warn('[review] share error:', err));
        return;
      }
      if (e.target.closest('.img-preview-link')) {
        e.preventDefault();
        openLightbox(e.target.closest('.img-preview-link').dataset.imgUrl);
        return;
      }
      if (e.target.closest('.chat-img')) { openLightbox(e.target.closest('.chat-img').src); return; }
      // ask_user 提交按钮：收集每组答案一次性回传
      const askSubmit = e.target.closest('.ask-submit');
      if (askSubmit) {
        const card = askSubmit.closest('.ask-card');
        if (card && card.dataset.askId && card.dataset.answered !== '1') {
          const answers = collectAskAnswers(card);
          if (answers) { lockAskCard(card); postAskAnswer(card.dataset.askId, answers); }
        }
        return;
      }
      const askOpt = e.target.closest('.ask-option');
      if (askOpt) {
        const card = askOpt.closest('.ask-card');
        const askId = card?.dataset?.askId;
        if (!askId) {
          // 老路径：fallback 把选项当 user_msg 发
          const text = askOpt.dataset.label || askOpt.textContent;
          if (text && state.currentTerminalId) {
            sendMessage(state.currentTerminalId, 'user_msg', { text }).catch(e =>
              console.warn('[stream-render] sendMessage:', e)
            );
          }
          return;
        }
        if (card.dataset.answered === '1') return;
        const group = askOpt.closest('.ask-group');
        const multi = group?.dataset.multi === '1';
        const single = parseInt(card.dataset.qcount || '1', 10) <= 1 && !multi;
        if (single) {
          // 单问题单选：点击即答（少一步）
          card.querySelectorAll('.ask-option').forEach(b => b.classList.remove('ask-option-selected'));
          askOpt.classList.add('ask-option-selected');
          lockAskCard(card);
          postAskAnswer(askId, [askOpt.dataset.label || askOpt.textContent]);
          return;
        }
        // 多问题/多选：仅改本组选中态，等点提交
        if (multi) {
          askOpt.classList.toggle('ask-option-selected');
        } else if (group) {
          group.querySelectorAll('.ask-option').forEach(b => b.classList.remove('ask-option-selected'));
          askOpt.classList.add('ask-option-selected');
        }
        const submitBtn = card.querySelector('.ask-submit');
        if (submitBtn) submitBtn.disabled = !collectAskAnswers(card);
        return;
      }
      const codeBtn = e.target.closest('.code-copy-btn');
      if (codeBtn) {
        const code = codeBtn.parentElement.querySelector('code');
        if (code) copyToClipboard(code.textContent, codeBtn);
        return;
      }
      const msgBtn = e.target.closest('.msg-copy-btn');
      if (msgBtn) {
        const raw = msgBtn.parentElement.dataset.raw;
        if (raw) copyToClipboard(raw, msgBtn);
      }
    };

    el.addEventListener('click', this._clickHandler);
    $('#orch-stream')?.addEventListener('click', this._clickHandler);

    $('#suggestion-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.suggest-chip');
      if (!chip || !state.currentTerminalId) return;
      const text = state.currentSuggestions[parseInt(chip.dataset.idx)];
      if (!text) return;
      chip.style.transform = 'scale(0.9)';
      clearSuggestionChips();
      sendMessage(state.currentTerminalId, 'user_msg', { text }).catch(e =>
        console.warn('[stream-render] suggestion send:', e)
      );
    });
  },

  unmount() {
    if (this._msgHandler) bus.off('message:new', this._msgHandler);
    if (this._deltaHandler) bus.off('stream:delta', this._deltaHandler);
    if (this._el && this._clickHandler) this._el.removeEventListener('click', this._clickHandler);
    this._el = this._msgHandler = this._deltaHandler = this._clickHandler = null;
  },
};
