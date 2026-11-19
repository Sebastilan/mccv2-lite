// review-link.js — 工具卡 [审阅] 链接 HTML 助手
// 给带文件路径的工具生成紫色小胶囊；
// 点击事件由 stream-render.js 委托处理（POST /api/review/share → 新窗 review.html）。

import { esc } from './escape.js';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'read_file', 'edit_file', 'write_file']);

export function reviewLinkHtml(toolName, input) {
  if (!FILE_TOOLS.has(toolName)) return '';
  const fp = input?.file_path || input?.notebook_path || input?.path;
  if (!fp) return '';
  return ` <a class="rv-link" href="#" data-rv-path="${esc(fp)}" title="${esc(fp)}">审阅</a>`;
}
