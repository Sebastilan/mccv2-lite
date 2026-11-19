// chat-actor-controls.js — 插件：chat 顶端右侧关闭按钮（×）
//
// × = 关闭终端（销毁 actor + 回 dashboard）。用户在手机上用全面屏手势返回，
// 不需要"返回"按钮；这里专门给"主动结束终端"用。
import { deleteActor } from '../core/api.js';
import { bus } from '../core/bus.js';
import { state } from '../core/state.js';
import { showToast } from '../ui/toast.js';
import { goBackReplace } from '../ui/terminal.js';

export default {
  id: 'chat-actor-controls',
  slot: 'chat.header.right',
  page: 'chat',
  order: 10,

  _el: null,

  mount(el) {
    this._el = el;

    el.innerHTML = `
      <div class="plugin-actor-controls">
        <button class="plugin-actor-control-btn plugin-actor-control-btn--danger" data-action="close" title="关闭终端">×</button>
      </div>
    `;

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="close"]');
      if (btn) this._close();
    });
  },

  unmount() {
    this._el = null;
  },

  async _close() {
    const id = state.currentTerminalId;
    if (!id) return;
    if (!confirm('确认关闭此终端？')) return;
    try {
      await deleteActor(id);
    } catch (e) {
      showToast(`关闭失败：${e.message}`, '', 'danger');
      return;
    }
    state.removeActor(id);
    bus.emit('actor:gone', id);
    goBackReplace();
  },
};
