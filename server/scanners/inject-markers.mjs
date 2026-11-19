// inject-markers.mjs — 平台注入块的单一事实源:marker 清单 + 纯函数 stripInjection / isGitStatusBlock
//
// 每轮平台给 CC 的首条 user 消息头部拼进一大坨注入(记忆库地图 / 常驻基因 / 决策摘要 /
// 携带快照 / 任务进程文件 / gitStatus 等),真实用户消息在最尾。本模块导出:
//   - INJECT_MARKERS   注入块行首标题清单(ctx-inspector 切层 + stripInjection 共用,单一事实源)
//   - isGitStatusBlock 判一段文本是否 gitStatus / 环境 的 <system-reminder> 块
//   - stripInjection   剥掉全部注入块,还原真实用户消息(历史抽屉纯文本显示用)

// 平台每轮注入的大块,按 marker 行首标题切层(顺序即注入顺序)。部分块用〔〕括号。
export const INJECT_MARKERS = [
  ['常驻·身份与红线', '🧬 常驻基因 / 红线'],
  ['记忆库地图', '🗺️ 记忆库地图'],
  ['决策摘要', '🧠 决策摘要'],
  ['携带快照', '📌 携带快照(上段前沿)'],
  ['本段对话', '💬 本段对话(逐字保真)'],
  ['最近对话', '💬 最近对话(历史压缩)'],
  ['最近一轮决策路径', '🧭 决策路径(最近一轮)'],   // 注入源用〔〕括号
  ['结算提醒', '⏰ 结算提醒'],                      // 同上
];

// 任务进程文件(process.md)注入块:头部标题排在 head 注入最后、真实用户消息之前,
// 结尾固定哨兵句「专心干活即可。」——是「注入区 / 真实消息」最可靠的分界点。
const PROCESS_HEADER = '任务进程文件';
const PROCESS_SENTINEL = '专心干活即可。';

// 某段文本是否为 gitStatus / 环境 的 system-reminder(应单列 / 剥除)
export function isGitStatusBlock(t) {
  return /<system-reminder>/.test(t)
    && (/#\s*gitStatus/.test(t) || /invoked in the following environment/.test(t));
}

const _esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 找行首标题「[【〔]title」的首个位置(排除正文中段引用)。返回标题起点索引,未命中 -1。
function _headerPos(text, title) {
  const m = new RegExp(`(?:^|\\n)[【〔]${_esc(title)}`).exec(text);
  return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : -1;
}

// stripInjection — 输入一条 user 消息全文,剥掉所有平台注入块,返回真实用户消息(trim)。
// 不变量:注入块恒在头部、真实消息恒在尾部 → 只需求「注入区末尾」realStart,slice 即得。
// realStart 取三类信号的最大值:①gitStatus 块末 ②process.md 哨兵末 ③注入区之后首个行首「用户：」。
// 无任何注入信号(纯用户消息 / 普通轮次)→ realStart=0 原样返回;剥完为空 → 回退原文,绝不吞消息。
export function stripInjection(userText) {
  if (typeof userText !== 'string') return '';
  if (!userText.trim()) return userText.trim();

  // 收集注入 marker 行首标题位置(含 process.md 头)
  const markerPositions = [];
  for (const [mk] of INJECT_MARKERS) {
    const p = _headerPos(userText, mk);
    if (p >= 0) markerPositions.push(p);
  }
  const procStart = _headerPos(userText, PROCESS_HEADER);
  if (procStart >= 0) markerPositions.push(procStart);

  let realStart = 0;

  // ① gitStatus / 环境 system-reminder 块末(恒在头部)
  const remRe = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
  let rm;
  while ((rm = remRe.exec(userText))) {
    if (isGitStatusBlock(rm[0])) realStart = Math.max(realStart, rm.index + rm[0].length);
  }

  // ② process.md 注入块:头 → 哨兵句结尾
  let procEnd = -1;
  if (procStart >= 0) {
    const sIdx = userText.indexOf(PROCESS_SENTINEL, procStart);
    if (sIdx >= 0) { procEnd = sIdx + PROCESS_SENTINEL.length; realStart = Math.max(realStart, procEnd); }
  }

  // ③ 注入区之后首个行首「用户：」——真实消息起点。阈值取「最后一个 marker / process 哨兵」之后,
  //    避免命中注入块内部(如决策摘要)引用的「用户：」。仅当确有注入块时才启用。
  if (markerPositions.length) {
    const threshold = Math.max(procEnd, ...markerPositions);
    const uRe = /(?:^|\n)用户：/g;
    let um;
    while ((um = uRe.exec(userText))) {
      const idx = um.index + (um[0].startsWith('\n') ? 1 : 0);
      if (idx >= threshold) { realStart = Math.max(realStart, idx); break; }
    }
  }

  let out = userText.slice(realStart);
  // 兜底:清掉尾部可能残留的 gitStatus / 环境 system-reminder 块
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, m => (isGitStatusBlock(m) ? '' : m));
  out = out.trim();
  return out || userText.trim();
}
