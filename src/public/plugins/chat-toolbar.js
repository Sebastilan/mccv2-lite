// chat-toolbar.js — 插件：终端 header 按钮 + 导航 + 区域控制（chat.header.right）
import { $, state, RELOAD_DELAY_MS } from '../core/state.js';
import { deleteActor, patchActorAdvisorType, sendControl, sendMessage } from '../core/api.js';
import { goBack, openTerminal } from '../ui/terminal.js';
import { startRename } from '../ui/rename.js';
import { hideSlashMenu, hideMentionMenu } from '../ui/terminal-input.js';
import { loadSkills, showSlashMenu, selectSlashItem, highlightSlash, selectMentionItem, highlightMention } from '../ui/slash-menu.js';
export const chatToolbarPlugin = {
  id: 'chat-toolbar',
  slot: 'chat.header.right',
  page: 'chat',
  order: 20,
  mount(_el) {
    // ─── 终端 header 按钮 ───
    $('#btn-back')?.addEventListener('click', goBack);
    $('#term-project')?.addEventListener('click', () => startRename($('#term-project'), state.currentTerminalId, false));
    $('#term-mode')?.addEventListener('click', () => {
      const tid = state.currentTerminalId; if (!tid) return;
      const t = state.dashboardData.find(t => t.id === tid); if (!t || t.mode !== 'advisor') return;
      const cycle = ['main', 'aux', 'auto'];
      patchActorAdvisorType(tid, cycle[(cycle.indexOf(t.advisorType || 'main') + 1) % cycle.length]).catch(() => {});
    });
    $('#btn-cancel')?.addEventListener('click', () => {
      if (state.currentTerminalId && confirm('确认关闭？')) { deleteActor(state.currentTerminalId).catch(() => {}); goBack(); }
    });
    $('#btn-interrupt')?.addEventListener('click', () => { if (state.currentTerminalId) sendControl(state.currentTerminalId, 'interrupt'); });
    $('#btn-cmd')?.addEventListener('click', () => {
      const i = $('#msg-input'); if (i && !i.value.startsWith('/')) i.value = '/'; i?.focus();
      loadSkills().then(() => showSlashMenu(''));
    });
    $('#btn-end-check')?.addEventListener('click', () => {
      if (state.currentTerminalId) sendMessage(state.currentTerminalId, 'user_msg', { text: '结束检查' });
    });

    // ─── 斜杠 / 提及菜单 ───
    $('#slash-menu')?.addEventListener('click', (e) => { const item = e.target.closest('.sm-item'); if (item) selectSlashItem(parseInt(item.dataset.idx)); });
    $('#slash-menu')?.addEventListener('mouseover', (e) => { const item = e.target.closest('.sm-item'); if (item) { state.slashIdx = parseInt(item.dataset.idx); highlightSlash(); } });
    $('#mention-menu')?.addEventListener('click', (e) => { const item = e.target.closest('.sm-item'); if (item) selectMentionItem(parseInt(item.dataset.idx)); });
    $('#mention-menu')?.addEventListener('mouseover', (e) => { const item = e.target.closest('.sm-item'); if (item) { state.mentionIdx = parseInt(item.dataset.idx); highlightMention(); } });

    // ─── Tab 切换 ───
    $('#tabs-scroll')?.addEventListener('click', (e) => {
      const pill = e.target.closest('.tab-pill');
      if (pill?.dataset.id && pill.dataset.id !== state.currentTerminalId) openTerminal(pill.dataset.id);
    });

    // ─── 标题清缓存 + 移动端算力 ───
    $('#mcc-title')?.addEventListener('click', () => {
      if ('caches' in window) caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))));
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
      setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    });
    $('#btn-machines-m')?.addEventListener('click', () => $('#machines-grid')?.classList.toggle('visible'));

    // ─── 浏览器历史导航 ───
    history.replaceState({ page: 'dashboard' }, '', location.href);
    window.addEventListener('popstate', () => {
      if (state._navSkip) { state._navSkip = false; return; }
      if ($('#page-history-detail')?.classList.contains('active')) {
        $('#page-history-detail').classList.remove('active'); $('#page-history')?.classList.add('active');
      } else if ($('#page-history')?.classList.contains('active')) {
        $('#page-history').classList.remove('active'); $('#page-dashboard')?.classList.add('active');
      } else if ($('#page-terminal')?.classList.contains('active')) {
        state.currentTerminalId = null; hideSlashMenu(); hideMentionMenu();
        $('#page-terminal').classList.remove('active'); $('#page-dashboard')?.classList.add('active');
      } else if ($('#page-dashboard')) {
        history.pushState({ page: 'dashboard' }, '', location.href);
      }
    });
  },
  unmount() {},
};
