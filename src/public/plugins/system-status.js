// system-status.js — 插件：系统状态条（CPU/RAM/DISK，app.header.right）
// 窄屏（≤599px）DOM 被 CSS 隐藏，本插件也跟随暂停 timer，省一次/30s 的 sysinfo 请求。
import { getSysInfo } from '../core/api.js';

const NARROW = '(max-width: 599px)';

export default {
  id: 'system-status',
  slot: 'app.header.right',
  page: 'dashboard',
  order: 10,

  _el: null,
  _timer: null,
  _mql: null,
  _onMqlChange: null,

  mount(el) {
    const bar = document.createElement('div');
    bar.className = 'header-group-pill';
    bar.innerHTML = '<span class="usage-chip usage-ok"><span class="usage-period">CPU</span><span class="usage-pct">…</span></span>';
    el.appendChild(bar);
    this._el = bar;

    this._refresh = async () => {
      if (!this._el) return;
      let d;
      try {
        d = await getSysInfo();
      } catch (e) {
        console.warn('[system-status] sysinfo unavailable:', e.message);
        if (this._el) this._el.innerHTML = '<span class="usage-chip usage-ok"><span class="usage-period">CPU</span><span class="usage-pct">—</span></span>';
        return;
      }
      if (!this._el) return;
      const cpu = d.cpu != null ? `${Math.round(d.cpu)}%` : '—';
      const ram = d.ram != null ? `${Math.round(d.ram)}%` : '—';
      const cls = 'usage-chip usage-ok';
      // 系统盘(/)占用;云虚机 statfs 失败返 null 不显示。≥80 警告色 ≥90 危险色
      const diskChip = d.disk?.pct != null
        ? `<span class="pill-sep">|</span>` +
          `<span class="usage-chip ${d.disk.pct >= 90 ? 'usage-danger' : d.disk.pct >= 80 ? 'usage-warn' : 'usage-ok'}" title="系统盘 剩余 ${d.disk.free_gb}G / 共 ${d.disk.total_gb}G"><span class="usage-period">DISK</span><span class="usage-pct">${d.disk.pct}%</span></span>`
        : '';
      // temp 仅实体机有(云虚机后端返 null 不显示);≥70 警告色 ≥85 危险色
      const tempChip = d.temp != null
        ? `<span class="pill-sep">|</span>` +
          `<span class="usage-chip ${d.temp >= 85 ? 'usage-danger' : d.temp >= 70 ? 'usage-warn' : 'usage-ok'}" title="CPU 温度"><span class="usage-pct">${Math.round(d.temp)}°C</span></span>`
        : '';
      this._el.innerHTML =
        `<span class="${cls}"><span class="usage-period">CPU</span><span class="usage-pct">${cpu}</span></span>` +
        `<span class="pill-sep">|</span>` +
        `<span class="${cls}"><span class="usage-period">RAM</span><span class="usage-pct">${ram}</span></span>` +
        diskChip +
        tempChip;
    };

    this._mql = window.matchMedia(NARROW);
    this._onMqlChange = () => this._applyVisibility();
    this._mql.addEventListener('change', this._onMqlChange);
    this._applyVisibility();
  },

  // 隐藏 = 停 timer 不拉 API；可见 = 立即刷一次 + 30s 轮询
  _applyVisibility() {
    const hidden = this._mql.matches;
    clearInterval(this._timer);
    this._timer = null;
    if (hidden) return;
    this._refresh();
    this._timer = setInterval(this._refresh, 30_000);
  },

  unmount() {
    clearInterval(this._timer);
    this._mql?.removeEventListener('change', this._onMqlChange);
    this._el?.remove();
    this._el = this._timer = this._mql = this._onMqlChange = this._refresh = null;
  },
};
