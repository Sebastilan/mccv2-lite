// zone-grouping.js — 君臣佐使分区 + 通用顶置卡（pinTop）：actor 分类工具
// page: 'all' — 纯工具模块，无 slot，不被 canvas 挂载

export const ZONE_SECTIONS = [
  { key: 'main', label: '君', cssClass: '' },
  { key: 'aux',  label: '臣', cssClass: ' aux' },
  { key: 'auto', label: '佐', cssClass: ' auto' },
];

function _sortByStatus(a, b) {
  const ap = a.status === 'idle' ? 0 : 1, bp = b.status === 'idle' ? 0 : 1;
  if (ap !== bp) return ap - bp;
  return a.lastActivityAt - b.lastActivityAt;
}

/**
 * 将 dashboardData 按 君/臣/佐/使 分组，pinTop actor 抽出。同时计算 ghost slots：
 * pinSlots 中没有对应 active actor 的 slot 渲染成占位卡（关了还在，点击重建）。
 *
 * 归类规则：
 *   - callbackTerminalId 存在 → 使（workers）
 *   - pinTop=true → pinned（独立全宽卡）
 *   - advisorType main/aux/auto → 君/臣/佐
 *
 * Ghost slot 规则：
 *   - pinSlots 中存在但没有 active actor 满足 actor.slotId === slot.id
 *
 * @param {Array} dashboardData - actor 视图对象数组
 * @param {Array} pinSlots - [{id, label, spawnMeta}] 占位声明
 * @returns {{ groups, workers, pinned, ghostSlots, waitingSet }}
 */
export function classifyActors(dashboardData, pinSlots = []) {
  const active = dashboardData.filter(t => t.status !== 'cancelled' && t.status !== 'failed');
  const waitingSet = new Set(
    dashboardData.filter(t => t.callbackTerminalId && t.status === 'busy').map(t => t.callbackTerminalId)
  );
  const advisors = active.filter(t =>
    !t.callbackTerminalId && !t.lightweight && !t.contextMode
  );
  const workers = active.filter(t =>
    !!t.callbackTerminalId && !t.lightweight && !t.contextMode
  );
  const groups = {};
  for (const s of ZONE_SECTIONS) groups[s.key] = [];
  const pinned = [];
  for (const t of advisors) {
    if (t.pinTop) pinned.push(t);
    else (groups[t.advisorType || 'main'] || groups.main).push(t);
  }
  for (const s of ZONE_SECTIONS) groups[s.key].sort(_sortByStatus);
  pinned.sort(_sortByStatus);
  workers.sort(_sortByStatus);

  const occupiedSlotIds = new Set(active.filter(t => t.slotId).map(t => t.slotId));
  const ghostSlots = pinSlots.filter(s => !occupiedSlotIds.has(s.id));

  return { groups, workers, pinned, ghostSlots, waitingSet };
}
