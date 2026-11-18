// mcc-title-status.js — MCC logo 字色融合三态：WS 连接 + 前端插件 + 服务端服务
// 优先级：disconnected(红，WS 断/服务 red) > warning(黄) > 默认(蓝)
import { bus } from '../core/bus.js';
import { state } from '../core/state.js';
import { getHealth, onHealthChange } from '../canvas/index.js';

export default {
  id: 'mcc-title-status',
  slot: 'app.header.right',
  page: 'dashboard',
  order: 0,

  _onOpen: null,
  _onClose: null,
  _unsubHealth: null,
  _lastHealth: 'green',

  mount(_el) {
    const title = document.getElementById('mcc-title');
    if (!title) return;

    const apply = () => {
      const wsOk = state.ws?.readyState === WebSocket.OPEN;
      if (!wsOk || this._lastHealth === 'red') title.dataset.status = 'disconnected';
      else if (this._lastHealth === 'yellow')   title.dataset.status = 'warning';
      else delete title.dataset.status;
      title.title = !wsOk ? 'WS 断开 — 点击刷新'
                : this._lastHealth === 'red'    ? '有服务掉线 — 点击查看 /plugins.html'
                : this._lastHealth === 'yellow' ? '有故障 — 点击查看 /plugins.html'
                : '点击刷新';
    };

    // 初始
    this._lastHealth = getHealth().aggregate;
    apply();

    this._onOpen  = () => apply();
    this._onClose = () => apply();
    bus.on('ws:open',   this._onOpen);
    bus.on('ws:closed', this._onClose);

    this._unsubHealth = onHealthChange((snap) => {
      this._lastHealth = snap.aggregate;
      apply();
    });

    // 点击清缓存刷新（V1 原行为，不引入跳转副作用）
    title.style.cursor = 'pointer';
    title.title = '点击刷新';
    title.addEventListener('click', this._onTitleClick = () => {
      if ('caches' in window) caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))));
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
      setTimeout(() => location.reload(), 100);
    });
  },

  unmount() {
    bus.off('ws:open',   this._onOpen);
    bus.off('ws:closed', this._onClose);
    this._unsubHealth?.();
    const title = document.getElementById('mcc-title');
    if (title) {
      delete title.dataset.status;
      title.removeEventListener('click', this._onTitleClick);
    }
    this._onOpen = null;
    this._onClose = null;
    this._unsubHealth = null;
    this._onTitleClick = null;
  },
};
