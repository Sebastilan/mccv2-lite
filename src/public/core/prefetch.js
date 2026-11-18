// prefetch.js — 战线B「切换即时」进场后台预取（无 DOM，纯依赖注入，可单测）
//
// 痛点2根因（见 mccv2-realtime-sync-pain 第24-26行）：进 MCC 后每个终端第一次切过去时才
// 现拉首屏一页（懒加载 loadActorHistory），那一下要等整轮公网 HTTP 往返（冷加载 2-3s）；
// 终端多时逐个点逐个卡。V1「点开即在」的本质是它后台早把数据对到本地。
//
// 修法（B1）：actors:loaded 之后台并行预取活跃终端各自首屏一页（带并发上限），写进
// state.messagesByActor + 标 historyLoaded + 建 terminalEvents 缓存 + 设 lastHistoryFetch，
// 使切过去命中本地、0 次现场首屏 HTTP。后续增量刷新交给 A1 周期对账（reconcileActor），
// 两战线共用后台同步骨架，不重复造轮子。
//
// 为什么依赖注入而非直接引 state/ws：ws.js 顶层 import 会拉进浏览器全局（WebSocket/location），
// Node 判分器无法直接 import。把编排逻辑做成纯函数 + 注入 state/loadActor，判分器就能 import
// 真身直接测，避免「判分器里另写一份、和真代码漂移」（战线A bench-realtime 是 port 复刻，这里更进一步测真身）。

export const PREFETCH_CONCURRENCY = 3;   // 并发上限：别一次性打爆后端 / 公网连接池
export const PREFETCH_MAX = 20;          // 软上限：终端极多时只预取最近活跃的前 N 个，其余仍懒加载兜底

// 选取需预取的 actor：活跃（非 gone/service/human）、非自己、非当前正看的、且首屏还没拉过。
// 按 last_seen 倒序（最近活跃的最可能被点开）优先，取前 PREFETCH_MAX 个。
export function selectPrefetchTargets(state, { max = PREFETCH_MAX } = {}) {
  const cands = [];
  for (const a of state.actors.values()) {
    if (!a || a.kind === 'service' || a.kind === 'human') continue;
    if (a.status === 'gone') continue;
    if (a.id === state.selfId || a.id === state.currentTerminalId) continue;
    if (state.historyLoaded.has(a.id)) continue;   // 已拉过（含当前终端 _initChatPage 正在拉的）→ 跳过
    cands.push(a);
  }
  cands.sort((x, y) => (y.last_seen || 0) - (x.last_seen || 0));
  return cands.slice(0, max).map(a => a.id);
}

// 后台并发预取（concurrency 上限，可中断、低优先）。
//   state     : 前端状态模型（读 actors/historyLoaded/currentTerminalId，写 lastHistoryFetch）
//   loadActor : 单终端首屏加载器（= ws.js 的 loadActorHistory，负责拉分页 + 建 messagesByActor/
//               historyLoaded/terminalEvents 缓存）。预取只做数据层，不触 DOM/renderEvents。
//   opts.now  : 时间源（判分器可注入确定值）
//   opts.shouldStop : 中断钩子（如切页/断连时停止预取，让位前台）
// 返回 { total, prefetched, skipped }。
export async function prefetchActors(state, loadActor, opts = {}) {
  const { concurrency = PREFETCH_CONCURRENCY, max = PREFETCH_MAX, now = Date.now, shouldStop } = opts;
  const queue = selectPrefetchTargets(state, { max });
  let prefetched = 0, skipped = 0, i = 0;

  async function worker() {
    while (i < queue.length) {
      if (shouldStop && shouldStop()) return;     // 中断：让位前台交互
      const actorId = queue[i++];
      // 每次动态复查：用户已切到此终端 → 让 _initChatPage 自己负责首屏，预取不与前台抢
      if (actorId === state.currentTerminalId || state.historyLoaded.has(actorId)) { skipped++; continue; }
      try {
        await loadActor(actorId);
        // 设 lastHistoryFetch：切过去时 _initChatPage 的 10s TTL 守卫据此跳过阻塞式首屏 HTTP
        state.lastHistoryFetch.set(actorId, now());
        prefetched++;
      } catch { skipped++; /* 预取失败静默：切过去时懒加载兜底，不影响正确性 */ }
    }
  }

  const n = Math.min(concurrency, queue.length);
  await Promise.all(Array.from({ length: n }, worker));
  return { total: queue.length, prefetched, skipped };
}
