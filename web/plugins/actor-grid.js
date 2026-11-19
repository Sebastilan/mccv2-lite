// actor-grid.js — 插件：actor 卡片网格 + 仪表盘渲染（dashboard.grid）
import { bus } from '../core/bus.js';
import { state } from '../core/state.js';
import { renderDashboard, initDashboardEvents } from '../ui/dashboard.js';
import { updateHeader, updateBusyBar, renderTabBar, goBack } from '../ui/terminal.js';
import { classifyActors } from './zone-grouping.js'; // 分区分类（分隔条由 renderDashboard 插入）
import { listActors } from '../core/api.js';

export const actorGridPlugin = {
  id: 'actor-grid',
  slot: 'dashboard.grid',
  page: 'dashboard',
  order: 10,
  mount(el) {
    // el = #term-list-body（anchor，实际渲染用 renderDashboard 的内部选择器）
    initDashboardEvents();

    // ── HTTP fallback：不傻等 WebSocket，挂载时直接拉 actor 数据渲染 ──
    // 老 WebView（Android TV 9）的 WebSocket 可能连不上或 cookie 转发失败，
    // 但 HTTP fetch 总是通的。先渲染再等 WS 更新。
    listActors().then(actors => {
      for (const a of actors) state.upsertActor(a);
      renderDashboard();
    }).catch(() => {});

    bus.on('ws:open', () => {
      setTimeout(() => renderDashboard(), 200);
    });

    bus.on('actors:loaded', () => {
      renderDashboard();
    });

    bus.on('actor:update', (actor) => {
      const t = state.dashboardData.find(t => t.id === actor.id);
      if (!t) return;
      renderDashboard();
      if (state.currentTerminalId === actor.id) {
        updateHeader(t); updateBusyBar(t); renderTabBar();
      }
    });

    bus.on('actor:gone', (actorId) => {
      if (state.currentTerminalId === actorId) goBack();
      renderDashboard();
    });
  },
  unmount() {},
};
