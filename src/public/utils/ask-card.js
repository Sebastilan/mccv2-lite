// ask-card.js — ask_user 问答卡 HTML 构建（多问题分组 + 提交按钮，stream-render/terminal-stream 共用）
import { esc } from './escape.js';

// 构建 .ask-card 内部 DOM。
// 渲染规则：每个问题独立成 .ask-group（带 data-multi），选项点击只改本组选中态；
//   - 单问题单选 → 点击即答（少一步，无提交按钮）
//   - 多问题 或 任一多选 → 出现「提交」按钮，全部组选完才启用，点提交一次性回传
// 点击/提交逻辑由 stream-render.js 的 document 级委托统一处理（覆盖两个渲染路径）。
export function askCardHtml(askId, questions) {
  const qs = (questions || []).map((q) => {
    const opts = (q.options || []).map(o =>
      `<button class="ask-option" type="button" data-label="${esc(o.label)}">${esc(o.label)}</button>`
    ).join('');
    return `<div class="ask-group" data-multi="${q.multiSelect ? '1' : '0'}">`
      + `<div class="ask-question">${esc(q.question || '')}</div>`
      + (opts ? `<div class="ask-options">${opts}</div>` : '')
      + `</div>`;
  }).join('');
  const list = questions || [];
  const needSubmit = list.length > 1 || list.some(q => q.multiSelect);
  const submit = needSubmit
    ? `<div class="ask-submit-row"><button class="ask-submit" type="button" disabled>提交</button></div>`
    : '';
  return `<div class="ask-card" data-ask-id="${esc(askId || '')}" data-qcount="${list.length}">${qs}${submit}</div>`;
}
