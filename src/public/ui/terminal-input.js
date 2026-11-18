// terminal-input.js — 消息输入框行为（输入自动伸缩 + 发送 + 斜杠菜单联动）

import { $, state, TEXTAREA_MAX_HEIGHT_PX } from '../core/state.js';
import { sendMessage } from '../core/api.js';
import { timeNow } from '../utils/time.js';
import { pushEvent, clearSuggestionChips } from './terminal.js';
import {
  loadSkills, showSlashMenu, hideSlashMenu, highlightSlash, selectSlashItem,
  showMentionMenu, hideMentionMenu, highlightMention, selectMentionItem,
} from './slash-menu.js';
import { renderAttachPreview } from './attachments.js';

export { hideSlashMenu, hideMentionMenu };

export function sendMsg() {
  const input = $('#msg-input');
  const text = input.value.trim();
  const atts = [...state.attachments];
  if (!text && !atts.length) return;
  const id = state.currentTerminalId;
  if (!id) return;
  clearSuggestionChips();
  hideSlashMenu(); hideMentionMenu();

  // 清输入框立即反馈（不等 HTTP）
  input.value = ''; input.style.height = 'auto';
  state.attachments = []; renderAttachPreview();

  const imgMds = atts.filter(a => (a.mimeType || '').startsWith('image/'))
    .map(a => `![${a.name || 'image'}](${a.data})`).join('\n');
  const fileMarks = atts.filter(a => !(a.mimeType || '').startsWith('image/'))
    .map(a => `📎 ${a.name || 'file'}`).join('  ');
  const detail = [text, imgMds, fileMarks].filter(Boolean).join('\n');
  const payload = { text };
  if (atts.length) payload.attachments = atts.map(a => ({ name: a.name, mimeType: a.mimeType, data: a.data }));

  // @ mention：扫文本里仍存在的 token，组装 meta.mentions（cc-pool 投递时追加 [引用上下文]）
  if (state.pendingMentions?.length) {
    const used = state.pendingMentions.filter(m => text.includes(m.token));
    if (used.length) {
      const seen = new Set();
      payload.meta = {
        mentions: used.filter(m => seen.has(m.actor_id) ? false : seen.add(m.actor_id))
          .map(m => ({ actor_id: m.actor_id, name: m.name })),
      };
    }
    state.pendingMentions = [];
  }

  // 无条件立即 POST 落库（consumed=0）——即便目标 busy/creating 也不在浏览器内存里暂存：
  // 后端 cc-pool deliverLoop 按 to_id+consumed=0 的 FIFO 队列自动投递，刷新/切走/掉线都不丢。
  // queued 只是显示层标记（busy 时画"排队中"气泡），CC 真正拿起该消息时（msg_started 事件）自动摘标。
  const toActor = state.actors.get(id);
  const queued = !!(toActor && (toActor.status === 'busy' || toActor.status === 'creating'));
  const time = timeNow();

  sendMessage(id, 'user_msg', payload).then(resp => {
    state.archiveSelfMessage(id, resp?.id, 'user_msg', payload);
    pushEvent(id, { time, action: 'user_message', detail, msgId: resp?.id, queued });
  }).catch(err => {
    pushEvent(id, { time, action: 'user_message', detail, failed: true });
    alert(`发送失败：${err?.name === 'AbortError' ? '超时（附件过大或网络太慢）' : (err?.message || '未知错误')}，请重试`);
  });
}

export function initInputEvents() {
  const input = $('#msg-input');
  if (!input) return;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, TEXTAREA_MAX_HEIGHT_PX) + 'px';
    const val = input.value;
    if (val.startsWith('/')) {
      if (state.mentionVisible) hideMentionMenu();
      loadSkills().then(() => showSlashMenu(val.substring(1)));
    } else if (state.slashVisible) {
      hideSlashMenu();
    }
    // @ mention 改由 plugins/actor-mention.js 的工具栏按钮触发，不再用 ^@ 文本自动弹
  });
  input.addEventListener('keydown', (e) => {
    if (state.mentionVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.mentionIdx = Math.min(state.mentionIdx + 1, state.mentionItems.length - 1); highlightMention(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.mentionIdx = Math.max(state.mentionIdx - 1, 0); highlightMention(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && state.mentionIdx >= 0) { e.preventDefault(); selectMentionItem(state.mentionIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideMentionMenu(); return; }
    }
    if (state.slashVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.slashIdx = Math.min(state.slashIdx + 1, state.slashItems.length - 1); highlightSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.slashIdx = Math.max(state.slashIdx - 1, 0); highlightSlash(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && state.slashIdx >= 0) { e.preventDefault(); selectSlashItem(state.slashIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
}
