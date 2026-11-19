// slots.js — 所有槽位声明（id → DOM 查找器 + 元数据）
// 修改规则：新增槽位只能在此文件，不能在插件内硬编码 selector

export const SLOT_DEFS = {
  // ── 全局 ──────────────────────────────────────────────────────────────
  'app.header.left':   { sel: '#header-left',     cap: 'many', layout: 'flex-row' },
  'app.header.right':  { sel: '.header',          cap: 'many', layout: 'flex-row' },
  'app.modal':         { sel: '#modal-create',    cap: 'one',  layout: 'stack'    },
  'app.toast':         { sel: '#toast-container', cap: 'many', layout: 'stack'    },

  // ── 仪表盘 ──────────────────────────────────────────────────────────
  'dashboard.toolbar': { sel: '#btn-add-terminal',  cap: 'one',  layout: 'flex-row' },
  'dashboard.banner':  { sel: '#dashboard-banner',  cap: 'many', layout: 'flex-row' },
  'dashboard.grid':    { sel: '#term-list-body',    cap: 'one',  layout: 'flex-col' },

  // ── 聊天/终端（chat.html）────────────────────────────────────────────
  'chat.header.right':        { sel: '#chat-header-right', cap: 'many', layout: 'flex-row' },
  'chat.messages':            { sel: '#event-stream',      cap: 'one',  layout: 'flex-col' },
  'chat.input':               { sel: '#input-area',        cap: 'one',  layout: 'flex-col' },
  'chat.input.slash':         { sel: '#chat-slash-slot',   cap: 'one',  layout: 'flex-col' },
  'chat.input.toolbar':       { sel: '#chat-input-toolbar-slot', cap: 'many', layout: 'flex-row' },
};
