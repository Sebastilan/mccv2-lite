// dashboard.js — 仪表盘渲染 + 终端卡片 + 事件委托（门面）

import { $, state } from '../core/state.js';
import { patchActorAdvisorType, patchActorLock, createActor, listPinSlots } from '../core/api.js';
import { startRename } from './rename.js';
import { termCard, ghostCard, patchCard, statusBadgeHtml } from './dashboard-card.js';
import { openTerminal } from './terminal.js';
import { ZONE_SECTIONS, classifyActors } from '../plugins/zone-grouping.js';

const PIN_SLOTS_POLL_MS = 30_000;
export function startPinSlotsPolling() {
  const tick = () => listPinSlots().then(slots => { state.pinSlots = slots; renderDashboard(); }).catch(() => {});
  tick();
  setInterval(tick, PIN_SLOTS_POLL_MS);
}

export {
  showModal, hideModal, doCreate,
  openHistory, closeHistory, loadHistory, openHistoryDetail, closeHistoryDetail, resumeSession,
} from './dashboard-modals.js';

export {
  fetchUsage, fetchSysInfo, fetchMachines, renderMachinesBtn, renderMachinesGrid, MACHINES_POLL_MS,
} from './dashboard-stats.js';

// ─── 仪表盘主渲染 ───

let _lastCardOrder = [];

export function renderDashboard() {
  const { groups, workers, pinned, ghostSlots, waitingSet } = classifyActors(state.dashboardData, state.pinSlots);

  const allCards = [...ZONE_SECTIONS.reduce((acc, s) => acc.concat(groups[s.key]), []), ...workers, ...pinned];
  const newOrder = [
    ...allCards.map(t => `${t.id}:${t.pinTop ? 'pin' : t.advisorType || 'main'}`),
    ...ghostSlots.map(s => `ghost:${s.id}`),
  ];
  const body = $('#term-list-body');
  const orderSame = newOrder.length === _lastCardOrder.length && newOrder.every((id, i) => id === _lastCardOrder[i]);

  if (orderSame && newOrder.length > 0) {
    const dataMap = new Map(allCards.map(t => [t.id, t]));
    body.querySelectorAll('.term-card[data-id]').forEach(cardEl => {
      const t = dataMap.get(cardEl.dataset.id);
      if (t) patchCard(cardEl, t, waitingSet);
    });
    for (const s of ZONE_SECTIONS) {
      const countEl = body.querySelector(`.section-divider[data-section="${s.key}"] .divider-count`);
      if (countEl && countEl.textContent !== String(groups[s.key].length)) countEl.textContent = groups[s.key].length;
    }
    const workerCount = body.querySelector('.section-divider[data-section="workers"] .divider-count');
    if (workerCount && workerCount.textContent !== String(workers.length)) workerCount.textContent = workers.length;
  } else {
    let html = '';
    for (const s of ZONE_SECTIONS) {
      const g = groups[s.key];
      if (!g.length) continue;
      const c = state._collapsedSections.has(s.key) ? ' collapsed' : '';
      html += `<div class="section-divider${s.cssClass}${c}" data-section="${s.key}"><span class="div-seg-l"></span><span class="divider-label"><span class="div-chevron">▾</span>${s.label}</span><span class="div-seg-r"></span><span class="divider-count">${g.length}</span></div>`;
      html += `<div class="card-grid">${g.map(t => termCard(t, true, waitingSet)).join('')}</div>`;
    }
    if (workers.length) {
      const wc = state._collapsedSections.has('workers') ? ' collapsed' : '';
      html += `<div class="section-divider workers${wc}" data-section="workers"><span class="div-seg-l"></span><span class="divider-label"><span class="div-chevron">▾</span>使</span><span class="div-seg-r"></span><span class="divider-count">${workers.length}</span></div>`;
      html += `<div class="card-grid">${workers.map(t => termCard(t, false, waitingSet)).join('')}</div>`;
    }
    const pinHtml = [
      ...pinned.map(t => termCard(t, false, waitingSet)),
      ...ghostSlots.map(s => ghostCard(s)),
    ];
    if (pinHtml.length) {
      html += `<div class="pinned-row">${pinHtml.join('')}</div>`;
    }
    body.innerHTML = html;
    _lastCardOrder = newOrder;
  }

  const totalAdvisors = ZONE_SECTIONS.reduce((n, s) => n + groups[s.key].length, 0);
  const hasContent = totalAdvisors || pinned.length || ghostSlots.length || workers.length;
  $('#empty-state')?.style && ($('#empty-state').style.display = hasContent ? 'none' : 'flex');
}

// ─── 仪表盘事件委托 ───

export function initDashboardEvents() {
  $('#terminal-list').addEventListener('click', (e) => {
    const secDiv = e.target.closest('.section-divider');
    if (secDiv) {
      const key = secDiv.dataset.section;
      if (state._collapsedSections.has(key)) state._collapsedSections.delete(key);
      else state._collapsedSections.add(key);
      secDiv.classList.toggle('collapsed');
      return;
    }

    const typeEl = e.target.closest('.card-type[data-atype]');
    if (typeEl) {
      e.stopPropagation();
      const tid = typeEl.dataset.atype;
      const t = state.dashboardData.find(t => t.id === tid);
      if (t) {
        const cycle = ['main', 'aux', 'auto'];
        const next = cycle[(cycle.indexOf(t.advisorType || 'main') + 1) % cycle.length];
        patchActorAdvisorType(tid, next).catch(() => {});
      }
      return;
    }

    const lockEl = e.target.closest('.card-lock');
    if (lockEl?.dataset.lock) {
      e.stopPropagation();
      patchActorLock(lockEl.dataset.lock, !lockEl.classList.contains('locked')).catch(() => {});
      return;
    }

    if (e.target.classList.contains('card-project-name')) {
      e.stopPropagation();
      const card = e.target.closest('.term-card');
      if (card?.dataset.id) startRename(e.target, card.dataset.id, true);
      return;
    }

    const spawnBtn = e.target.closest('.card-spawn[data-spawn-kind]');
    if (spawnBtn) {
      e.stopPropagation();
      const kind = spawnBtn.dataset.spawnKind;
      const name = kind === 'chat' ? '慢聊' : '灵';
      // pinTop（无 slotId）= 跟顶置槽同名同层但不占单例位，落在同一顶置行、tab 栏同一第一层级
      createActor({ kind, meta: { name, pinTop: true } })
        .then(({ actorId }) => { if (actorId) openTerminal(actorId); }).catch(() => {});
      return;
    }

    const ghost = e.target.closest('.term-card.ghost[data-slot]');
    if (ghost) {
      const slotId = ghost.dataset.slot;
      const slot = state.pinSlots.find(s => s.id === slotId);
      if (!slot) return;
      const spawnMeta = slot.spawnMeta;
      createActor(spawnMeta).then(({ actorId }) => { if (actorId) openTerminal(actorId); }).catch(() => {});
      return;
    }

    const card = e.target.closest('.term-card');
    if (card) openTerminal(card.dataset.id);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('.btn-machines')) {
      e.stopPropagation();
      $('#machines-grid')?.classList.toggle('visible');
    }
  });
}
