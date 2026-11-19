// new-terminal-btn.js — 插件：新建终端按钮（dashboard.toolbar）
import { showModal } from '../ui/dashboard-modals.js';

export const newTerminalBtnPlugin = {
  id: 'new-terminal-btn',
  slot: 'dashboard.toolbar',
  page: 'dashboard',
  order: 10,
  mount(el) {
    // el = #btn-add-terminal
    el.addEventListener('click', showModal);
  },
  unmount() {},
};
