// chat-slash-menu.js — 插件：actor-kind 感知的 slash 命令面板（chat.input.slash）
import { $, state } from '../core/state.js';
import { bus } from '../core/bus.js';

const COMMANDS = {
  cc:    ['/clear', '/resume', '/think', '/compact', '/help'],
  human: [],
};

function _getKind() {
  const id = state.currentTerminalId;
  if (!id) return 'cc';
  const actor = state.actors.get(id);
  return actor?.kind || 'cc';
}

export default {
  id: 'chat-slash-menu',
  slot: 'chat.input.slash',
  page: 'chat',
  order: 5,

  _el: null,
  _menu: null,
  _onInput: null,

  mount(el) {
    this._el = el;
    el.innerHTML = `<div class="slash-plugin-menu" style="display:none"></div>`;
    this._menu = el.querySelector('.slash-plugin-menu');

    this._onInput = () => {
      const input = $('#msg-input');
      if (!input) return;
      const val = input.value;
      if (!val.startsWith('/')) { this._hide(); return; }
      const q = val.slice(1).toLowerCase();
      const kind = _getKind();
      const cmds = COMMANDS[kind] || COMMANDS.cc;
      const filtered = q ? cmds.filter(c => c.slice(1).startsWith(q)) : cmds;
      if (!filtered.length) { this._hide(); return; }
      this._show(filtered, input);
    };

    $('#msg-input')?.addEventListener('input', this._onInput);

    // close on Esc in the input
    $('#msg-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._menu.style.display !== 'none') {
        e.preventDefault();
        this._hide();
      }
    });

    this._menu.addEventListener('click', (e) => {
      const item = e.target.closest('.slash-plugin-item');
      if (!item) return;
      const cmd = item.dataset.cmd;
      const input = $('#msg-input');
      if (input) { input.value = cmd + ' '; input.focus(); }
      this._hide();
    });
  },

  _show(cmds, _input) {
    this._menu.innerHTML = cmds.map(c =>
      `<div class="slash-plugin-item" data-cmd="${c}">${c}</div>`
    ).join('');
    this._menu.style.display = 'block';
  },

  _hide() {
    if (this._menu) this._menu.style.display = 'none';
  },

  unmount() {
    if (this._onInput) $('#msg-input')?.removeEventListener('input', this._onInput);
    this._el = this._menu = this._onInput = null;
  },
};
