// ctx-inspector.js — 插件：点击 header 的 #term-ctx 徽章 → 弹出「上下文检视器」覆盖层
// 摊开看这个 CC 终端当前上下文窗口里装了什么：headline 真实 token + 分类占比条 +
// 📑 概览导航卡(锚点跳转) + 物理序逐块铺开(与真实请求顺序一致)。每块默认折叠只见标题，点开见完整原文。
// 数据源:后端只读端点 GET /api/actors/:id/context(读 CC CLI 落盘的 session jsonl)。
import { $, state, BASE_PATH } from '../core/state.js';
import { sendMessage } from '../core/api.js';
import { esc } from '../utils/escape.js';
import { renderMd } from '../utils/markdown.js';
import { timeNow } from '../utils/time.js';
import { pushEvent } from '../ui/terminal.js';

const STYLE_ID = 'ctxi-style';
const STYLE = `
/* 浅色为默认值(GitHub-light);加 .ctxi-dark 切回原深色集(GitHub-dark) */
.ctxi-overlay{
  --ctxi-overlay-bg:rgba(27,31,36,.45);
  --ctxi-panel-bg:#ffffff;
  --ctxi-shadow:rgba(31,35,40,.22);
  --ctxi-border:#d0d7de;
  --ctxi-border-soft:#d8dee4;
  --ctxi-text:#1f2328;
  --ctxi-title:#1f2328;
  --ctxi-muted:#57606a;
  --ctxi-body-text:#424a53;
  --ctxi-md-h:#1f2328;
  --ctxi-accent:#0969da;
  --ctxi-surface:#f6f8fa;
  --ctxi-control-bg:#f6f8fa;
  --ctxi-control-hover:#eaeef2;
  --ctxi-hd-hover:#eaeef2;
  --ctxi-bar-bg:#eaeef2;
  --ctxi-textarea-bg:#ffffff;
  --ctxi-note-ed-bg:#f6f8fa;
  --ctxi-submit-bg:#0969da;
  --ctxi-submit-hover:#0860ca;
  --ctxi-save-bg:#1f883d;
  --ctxi-save-hover:#1a7f37;
  --ctxi-foot-msg:#1a7f37;
  --ctxi-para-hover:rgba(9,105,218,.08);
  --ctxi-note-accent:#9a6700;
  --ctxi-note-q-fg:#9a6700;
  --ctxi-system-bg:#fff1e5;   --ctxi-system-fg:#bc4c00;   --ctxi-system-border:#f0883e88;
  --ctxi-memex-bg:#fbefff;    --ctxi-memex-fg:#8250df;    --ctxi-memex-border:#8957e588;
  --ctxi-inject-bg:#ddf4ff;   --ctxi-inject-fg:#0969da;
  --ctxi-asst-bg:#dafbe1;     --ctxi-asst-fg:#1a7f37;
  --ctxi-user-bg:#fff8c5;     --ctxi-user-fg:#9a6700;
  --ctxi-tooluse-bg:#eaeef2;  --ctxi-tooluse-fg:#57606a;
  --ctxi-toolres-bg:#ffebe9;  --ctxi-toolres-fg:#cf222e;
  --ctxi-cs-cached:#1a7f37;   --ctxi-cs-new:#0969da;
  --ctxi-cstag-cached-bg:#dafbe1; --ctxi-cstag-cached-fg:#1a7f37;
  --ctxi-cstag-new-bg:#ddf4ff;    --ctxi-cstag-new-fg:#0969da;
  --ctxi-unknown-bg:#fff1e5;  --ctxi-unknown-fg:#bc4c00;
  --ctxi-flash:rgba(9,105,218,.45);
  --ctxi-ov-bg:#f6f8fa;       --ctxi-ov-border:#0969da55;
  position:fixed;inset:0;z-index:9000;background:var(--ctxi-overlay-bg);
  display:flex;justify-content:center;align-items:flex-start;padding:24px 16px;
  backdrop-filter:blur(2px);overflow:auto}
.ctxi-overlay.ctxi-dark{
  --ctxi-overlay-bg:rgba(1,4,9,.72);
  --ctxi-panel-bg:#0d1117;
  --ctxi-shadow:rgba(0,0,0,.5);
  --ctxi-border:#30363d;
  --ctxi-border-soft:#21262d;
  --ctxi-text:#c9d1d9;
  --ctxi-title:#fff;
  --ctxi-muted:#8b949e;
  --ctxi-body-text:#9aa6b2;
  --ctxi-md-h:#e6edf3;
  --ctxi-accent:#58a6ff;
  --ctxi-surface:#161b22;
  --ctxi-control-bg:#21262d;
  --ctxi-control-hover:#30363d;
  --ctxi-hd-hover:#1c232c;
  --ctxi-bar-bg:#161b22;
  --ctxi-textarea-bg:#0d1117;
  --ctxi-note-ed-bg:#10151c;
  --ctxi-submit-bg:#1f6feb;
  --ctxi-submit-hover:#388bfd;
  --ctxi-save-bg:#238636;
  --ctxi-save-hover:#2ea043;
  --ctxi-foot-msg:#7ee787;
  --ctxi-para-hover:rgba(56,139,253,.09);
  --ctxi-note-accent:#9e6a03;
  --ctxi-note-q-fg:#e3b341;
  --ctxi-system-bg:#f0883e33;  --ctxi-system-fg:#ffa657;  --ctxi-system-border:#f0883e55;
  --ctxi-memex-bg:#8957e533;   --ctxi-memex-fg:#d2a8ff;   --ctxi-memex-border:#8957e555;
  --ctxi-inject-bg:#1f6feb33;  --ctxi-inject-fg:#79c0ff;
  --ctxi-asst-bg:#23863633;    --ctxi-asst-fg:#7ee787;
  --ctxi-user-bg:#9e6a0333;    --ctxi-user-fg:#e3b341;
  --ctxi-tooluse-bg:#6e768133; --ctxi-tooluse-fg:#adbac7;
  --ctxi-toolres-bg:#da363322; --ctxi-toolres-fg:#ff7b72;
  --ctxi-cs-cached:#2ea043;    --ctxi-cs-new:#1f6feb;
  --ctxi-cstag-cached-bg:#2ea04322; --ctxi-cstag-cached-fg:#3fb950;
  --ctxi-cstag-new-bg:#1f6feb22;    --ctxi-cstag-new-fg:#79c0ff;
  --ctxi-unknown-bg:#f0883e33; --ctxi-unknown-fg:#ffa657;
  --ctxi-flash:rgba(56,139,253,.5);
  --ctxi-ov-bg:#161b22;        --ctxi-ov-border:#1f6feb66}
.ctxi-panel{background:var(--ctxi-panel-bg);border:1px solid var(--ctxi-border);border-radius:12px;
  width:100%;max-width:880px;color:var(--ctxi-text);font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
  box-shadow:0 16px 48px var(--ctxi-shadow);display:flex;flex-direction:column;max-height:calc(100vh - 48px)}
.ctxi-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--ctxi-border-soft);flex:0 0 auto}
.ctxi-title{font-size:15px;font-weight:700;color:var(--ctxi-title);flex:1}
.ctxi-close,.ctxi-theme{background:var(--ctxi-control-bg);border:1px solid var(--ctxi-border);color:var(--ctxi-muted);border-radius:6px;
  width:30px;height:30px;cursor:pointer;font-size:15px;line-height:1}
.ctxi-close:hover,.ctxi-theme:hover{background:var(--ctxi-control-hover)}
.ctxi-body{padding:16px 18px;overflow:auto;flex:1 1 auto}
.ctxi-big{font-size:28px;font-weight:700;color:var(--ctxi-accent)}
.ctxi-sub{color:var(--ctxi-muted);font-size:12px;margin-bottom:12px}
.ctxi-msg{color:var(--ctxi-muted);text-align:center;padding:40px 0}
.ctxi-bar{display:flex;height:14px;border-radius:5px;overflow:hidden;margin:6px 0 10px;background:var(--ctxi-bar-bg)}
.ctxi-bar span{display:block;height:100%}
.ctxi-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--ctxi-muted);margin-bottom:8px}
.ctxi-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}
.ctxi-blk{border:1px solid var(--ctxi-border);border-radius:8px;margin:6px 0;overflow:hidden}
.ctxi-hd{display:flex;align-items:center;gap:9px;padding:8px 12px;background:var(--ctxi-surface);cursor:pointer;user-select:none}
.ctxi-hd:hover{background:var(--ctxi-hd-hover)}
.ctxi-chev{color:var(--ctxi-muted);font-size:10px;transition:transform .15s;flex:0 0 auto}
.ctxi-blk.open .ctxi-chev{transform:rotate(90deg)}
.ctxi-badge{font-size:10px;padding:2px 7px;border-radius:9px;font-weight:600;flex:0 0 auto}
.ctxi-lbl{flex:1;font-weight:600;color:var(--ctxi-text);word-break:break-word}
.ctxi-tok{color:var(--ctxi-muted);font-size:11px;flex:0 0 auto}
.ctxi-body-text{display:none;padding:10px 12px;white-space:pre-wrap;word-break:break-word;
  color:var(--ctxi-body-text);font-size:12px;border-top:1px solid var(--ctxi-border-soft);max-height:460px;overflow:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ctxi-blk.open .ctxi-body-text{display:block}
.ctxi-body-text.ctxi-md{white-space:normal;font-family:-apple-system,Segoe UI,Roboto,sans-serif;
  font-size:12.5px;color:var(--ctxi-text)}
.ctxi-md p{margin:6px 0}
.ctxi-md h1,.ctxi-md h2,.ctxi-md h3,.ctxi-md h4{margin:10px 0 5px;color:var(--ctxi-md-h);font-size:13.5px}
.ctxi-md ul,.ctxi-md ol{margin:4px 0;padding-left:20px}
.ctxi-md code{background:var(--ctxi-surface);border:1px solid var(--ctxi-border-soft);border-radius:4px;padding:1px 5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.ctxi-md pre{background:var(--ctxi-surface);border:1px solid var(--ctxi-border-soft);border-radius:6px;padding:8px 10px;
  overflow:auto;margin:6px 0}
.ctxi-md pre code{background:none;border:none;padding:0}
.ctxi-md table{border-collapse:collapse;margin:6px 0}
.ctxi-md th,.ctxi-md td{border:1px solid var(--ctxi-border);padding:3px 8px;font-size:12px}
.ctxi-md blockquote{border-left:3px solid var(--ctxi-border);margin:6px 0;padding:0 10px;color:var(--ctxi-muted)}
.ctxi-md a{color:var(--ctxi-accent)}
.ctxi-system .ctxi-badge{background:var(--ctxi-system-bg);color:var(--ctxi-system-fg)}
.ctxi-system.ctxi-blk{border-color:var(--ctxi-system-border)}
.ctxi-memex .ctxi-badge{background:var(--ctxi-memex-bg);color:var(--ctxi-memex-fg)}
.ctxi-inject .ctxi-badge{background:var(--ctxi-inject-bg);color:var(--ctxi-inject-fg)}
.ctxi-think .ctxi-badge{background:var(--ctxi-memex-bg);color:var(--ctxi-memex-fg)}
.ctxi-asst .ctxi-badge{background:var(--ctxi-asst-bg);color:var(--ctxi-asst-fg)}
.ctxi-user .ctxi-badge{background:var(--ctxi-user-bg);color:var(--ctxi-user-fg)}
.ctxi-tooluse .ctxi-badge{background:var(--ctxi-tooluse-bg);color:var(--ctxi-tooluse-fg)}
.ctxi-toolres .ctxi-badge{background:var(--ctxi-toolres-bg);color:var(--ctxi-toolres-fg)}
.ctxi-memex-call .ctxi-badge{background:var(--ctxi-memex-bg);color:var(--ctxi-memex-fg)}
.ctxi-memex-call.ctxi-blk{border-color:var(--ctxi-memex-border)}
.ctxi-unknown .ctxi-badge{background:var(--ctxi-unknown-bg);color:var(--ctxi-unknown-fg)}
.ctxi-unknown.ctxi-blk{border-color:var(--ctxi-system-border)}
.ctxi-memex.ctxi-blk{border-color:var(--ctxi-memex-border)}
/* 概览导航卡 */
.ctxi-overview.ctxi-blk{border-color:var(--ctxi-ov-border)}
.ctxi-overview .ctxi-badge{background:var(--ctxi-ov-bg);color:var(--ctxi-accent)}
.ctxi-ov-body{white-space:normal!important;font-family:-apple-system,Segoe UI,Roboto,sans-serif!important;
  font-size:12.5px;color:var(--ctxi-text);line-height:1.9}
.ctxi-ov-grp{display:inline}
.ctxi-ov-sep{color:var(--ctxi-muted);margin:0 4px}
.ctxi-nav{color:var(--ctxi-accent);cursor:pointer;text-decoration:none;border-bottom:1px dashed var(--ctxi-accent);
  padding:0 1px;margin:0 2px;white-space:nowrap}
.ctxi-nav:hover{background:var(--ctxi-para-hover);border-radius:3px}
/* 锚点跳转后短暂高亮闪烁 */
@keyframes ctxi-flash-kf{0%{box-shadow:0 0 0 3px var(--ctxi-flash)}100%{box-shadow:0 0 0 0 transparent}}
.ctxi-flash{animation:ctxi-flash-kf 1.3s ease-out}
.term-ctx{cursor:pointer}
.term-ctx:hover{text-decoration:underline}
.ctxi-note-btn{background:none;border:none;color:var(--ctxi-muted);cursor:pointer;font-size:13px;
  padding:0 2px;flex:0 0 auto;line-height:1;opacity:.55}
.ctxi-note-btn:hover{opacity:1}
.ctxi-note-cnt{background:var(--ctxi-note-accent);color:#fff;font-size:10px;font-weight:700;border-radius:8px;
  padding:1px 6px;flex:0 0 auto}
.ctxi-note-ed{padding:10px 12px;border-top:1px solid var(--ctxi-border-soft);background:var(--ctxi-note-ed-bg)}
.ctxi-note-q{border-left:3px solid var(--ctxi-note-accent);padding:2px 8px;margin-bottom:6px;color:var(--ctxi-note-q-fg);
  font-size:12px;word-break:break-word}
.ctxi-note-ed textarea{width:100%;box-sizing:border-box;background:var(--ctxi-textarea-bg);border:1px solid var(--ctxi-border);
  border-radius:6px;color:var(--ctxi-text);font:12.5px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
  padding:7px 9px;min-height:60px;resize:vertical}
.ctxi-note-ed textarea:focus{outline:none;border-color:var(--ctxi-accent)}
.ctxi-note-ops{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.ctxi-note-ops button{border-radius:6px;border:1px solid var(--ctxi-border);cursor:pointer;
  font-size:12px;padding:4px 12px}
.ctxi-note-save{background:var(--ctxi-save-bg);border-color:var(--ctxi-save-bg)!important;color:#fff}
.ctxi-note-save:hover{background:var(--ctxi-save-hover)}
.ctxi-note-cancel{background:var(--ctxi-control-bg);color:var(--ctxi-text)}
.ctxi-note-cancel:hover{background:var(--ctxi-control-hover)}
.ctxi-foot{flex:0 0 auto;border-top:1px solid var(--ctxi-border-soft);padding:10px 18px;display:flex;
  align-items:center;gap:10px;justify-content:flex-end}
.ctxi-foot-msg{color:var(--ctxi-foot-msg);font-size:12px}
.ctxi-submit{background:var(--ctxi-submit-bg);border:none;color:#fff;border-radius:6px;cursor:pointer;
  font-size:13px;font-weight:600;padding:6px 16px}
.ctxi-submit:hover{background:var(--ctxi-submit-hover)}
.ctxi-submit:disabled{opacity:.5;cursor:default}
.ctxi-body{position:relative}
.ctxi-para-hover{background:var(--ctxi-para-hover);border-radius:4px;cursor:pointer}
/* 缓存命中可视化：块左侧色条 + 头部小标 */
.ctxi-cs-cached{box-shadow:inset 3px 0 0 var(--ctxi-cs-cached)}
.ctxi-cs-new{box-shadow:inset 3px 0 0 var(--ctxi-cs-new)}
.ctxi-cstag{font-size:10px;font-weight:600;border-radius:8px;padding:1px 6px;flex:0 0 auto}
.ctxi-cstag-cached{background:var(--ctxi-cstag-cached-bg);color:var(--ctxi-cstag-cached-fg)}
.ctxi-cstag-new{background:var(--ctxi-cstag-new-bg);color:var(--ctxi-cstag-new-fg)}
.ctxi-cache-legend{margin-top:-4px;margin-bottom:10px;align-items:center}
.ctxi-cache-legend i{border-radius:1px;width:14px;height:9px}
.ctxi-cache-nums{color:var(--ctxi-text);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.ctxi-cache-mode{font-size:10.5px;padding:1px 6px;border-radius:3px;background:var(--ctxi-badge-bg,#eaeef2);color:var(--ctxi-text);font-weight:600}
.ctxi-turn-hd{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;margin:12px 0 4px;padding:2px 8px;border-radius:4px;user-select:none}
.ctxi-turn-u{background:rgba(191,135,0,.12);color:#bf8700;border-left:3px solid #bf8700}
.ctxi-turn-a{background:rgba(26,127,55,.10);color:#1a7f37;border-left:3px solid #1a7f37}
`;

// category → 徽章文字（section 用 category 字段，稳定）
const BADGE = {
  system: '系统', memex: 'memex', 'memex-call': '召回', inject: '注入', think: '思考',
  asst: '正文', user: '用户', tooluse: '调用', toolres: '结果', unknown: '未知',
  overview: '概览',
};

// breakdown.cat 是中文分类名，按关键词上色（与 section 配色一致）
function catColor(cat) {
  if (cat.includes('系统')) return '#e16f24';
  if (cat.includes('memex')) return '#8250df';
  if (cat.includes('注入')) return '#0969da';
  if (cat.includes('思考')) return '#a475f9';
  if (cat.includes('助手')) return '#1a7f37';
  if (cat.includes('用户')) return '#bf8700';
  if (cat.includes('调用')) return '#8c959f';
  if (cat.includes('结果')) return '#cf222e';
  return '#6e7681';
}

function fmt(n) { return (n || 0).toLocaleString('en-US'); }

// 文本类内容走 MD 渲染；工具调用/结果是 JSON/代码，保持等宽纯文本
const MD_CATS = new Set(['system', 'memex', 'inject', 'asst', 'user', 'think']);

// 「本段对话」逐轮渲染：按行首 用户：/你： 切发言段，插入发言人色条分隔。
// 分隔条与 MD 段落平级（都是 body-text 直接子元素），段落级批注粒度不受影响。
function renderDialogue(body) {
  const re = /(?:^|\n)(用户|你)：/g;
  const cuts = []; let m;
  while ((m = re.exec(body))) cuts.push([m.index + (m[0].startsWith('\n') ? 1 : 0), m[1]]);
  if (!cuts.length) return renderMd(body || '(空)');
  let html = '';
  const lead = body.slice(0, cuts[0][0]).trim();  // 块标题行【本段对话·全量…】
  if (lead) html += renderMd(lead);
  for (let i = 0; i < cuts.length; i++) {
    const [p, who] = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1][0] : body.length;
    const seg = body.slice(p + who.length + 1, end).trim();
    html += `<div class="ctxi-turn-hd ctxi-turn-${who === '用户' ? 'u' : 'a'}">${who === '用户' ? '👤 用户' : '🤖 你'}</div>` + renderMd(seg || '(空)');
  }
  return html;
}

// 块轻量签名:必须与后端 sectionSig 同公式(body 长度 + 标题)。
const sectionSig = (s) => (s.body || '').length + ':' + (s.title || '');

// 前端计算每块 cacheState(后端不再判定)。就地写回 s.cacheState,返回是否走精确 diff。
// 有 prevSigs(turn-first↔prev 前缀 diff):逐块签名与 prevSigs 从头比对,连续相等的最长前缀
//   标 cached,首个不等块(或 prev 用尽)及之后标 new。
// 无 prevSigs(冷启/旧 wrapper 兜底):按 cache_read 从头累加 section.tok,落在命中量内的前缀标 cached。
function computeCacheStates(secs, prevSigs, cacheRead) {
  if (Array.isArray(prevSigs)) {
    let boundary = 0;
    while (boundary < secs.length && boundary < prevSigs.length
           && sectionSig(secs[boundary]) === prevSigs[boundary]) boundary++;
    secs.forEach((s, i) => { s.cacheState = i < boundary ? 'cached' : 'new'; });
    return true;
  }
  let acc = 0, boundary = 0;
  for (let i = 0; i < secs.length; i++) {
    acc += secs[i].tok || 0;
    if (acc <= cacheRead) boundary = i + 1; else break;
  }
  secs.forEach((s, i) => { s.cacheState = i < boundary ? 'cached' : 'new'; });
  return false;
}

function blockHtml(s) {
  const badge = BADGE[s.category] || s.category;
  const md = MD_CATS.has(s.category);
  const body = md
    ? ((s.title || '').includes('本段对话') ? renderDialogue(s.body || '') : renderMd(s.body || '(空)'))
    : esc(s.body || '(空)');
  // 缓存状态:后端按真实序算好,色条/小标直接跟块走,不受 memex 提顶重排影响
  const cs = s.cacheState === 'cached' ? 'cached' : 'new';
  const cstag = cs === 'cached'
    ? '<span class="ctxi-cstag ctxi-cstag-cached" title="命中上轮请求前缀,本轮缓存复用">🟢 缓存命中</span>'
    : '<span class="ctxi-cstag ctxi-cstag-new" title="缓存断点之后,本轮新增需重算">🔵 本轮新增</span>';
  return `<div id="ctxi-blk-${esc(s.id)}" class="ctxi-blk ctxi-${esc(s.category)} ctxi-cs-${cs}" data-badge="${esc(badge)}" data-title="${esc(s.title)}">
    <div class="ctxi-hd">
      <span class="ctxi-chev">▶</span>
      <span class="ctxi-badge">${esc(badge)}</span>
      ${cstag}
      <span class="ctxi-lbl">${esc(s.title)}</span>
      <span class="ctxi-note-cnt" hidden></span>
      <button class="ctxi-note-btn" title="批注整块（展开后点任一段落可单独批注该段）">💬</button>
      <span class="ctxi-tok">~${fmt(s.tok)} tok</span>
    </div>
    <div class="ctxi-body-text${md ? ' ctxi-md' : ''}">${body}</div>
    <div class="ctxi-note-ed" hidden>
      <div class="ctxi-note-q" hidden></div>
      <textarea placeholder="写批注…（提交后作为消息发进该终端，CC 会在聊天流里回复）"></textarea>
      <div class="ctxi-note-ops">
        <button class="ctxi-note-cancel">取消</button>
        <button class="ctxi-note-save">暂存</button>
      </div>
    </div>
  </div>`;
}

// 概览导航卡：按 section kind 汇总计数 + 把 memex 模块名 / 注入块名做成锚点，
// 点击平滑滚动到该 section 在物理序的真实位置并闪烁高亮。默认展开（带 open）。
const CONV_CATS = new Set(['think', 'asst', 'user', 'tooluse', 'toolres', 'memex-call', 'unknown']);
function overviewCard(secs) {
  const sys = secs.filter(s => s.category === 'system');
  const memex = secs.filter(s => s.category === 'memex');
  const inject = secs.filter(s => s.category === 'inject');
  const conv = secs.filter(s => CONV_CATS.has(s.category));
  // 去掉标题前导 emoji/符号,留模块名/块名本体做锚点文字
  const name = (s) => (s.title || '').replace(/^[\s\p{P}\p{S}]+/u, '').trim() || s.title || s.id;
  const link = (s) => `<a class="ctxi-nav" data-target="ctxi-blk-${esc(s.id)}" title="跳到物理序第 ${esc(s.id)} 块">${esc(name(s))}</a>`;
  const grp = (label, list) => `<span class="ctxi-ov-grp">${label}${list.length ? '：' + list.map(link).join(' ') : ''}</span>`;
  const parts = [
    `<span class="ctxi-ov-grp">🔒 系统(${sys.length})</span>`,
    grp(`🧠 memex(${memex.length})`, memex),
    grp(`📥 注入(${inject.length})`, inject),
    `<span class="ctxi-ov-grp">⏱ 对话(${conv.length})</span>`,
  ];
  return `<div class="ctxi-blk ctxi-overview open">
    <div class="ctxi-hd">
      <span class="ctxi-chev">▶</span>
      <span class="ctxi-badge">概览</span>
      <span class="ctxi-lbl">📑 上下文概览 · 点模块名/块名跳到物理序</span>
      <span class="ctxi-tok">${secs.length} 块</span>
    </div>
    <div class="ctxi-body-text ctxi-ov-body">${parts.join('<span class="ctxi-ov-sep">·</span>')}</div>
  </div>`;
}

// 单一视图：概览导航卡 + 物理序扁平块列表（与真实请求顺序逐块一致，无重排、无分组）。
function renderData(d) {
  if (!d.available) {
    return `<div class="ctxi-msg">该终端暂不支持上下文检视<br><span style="font-size:12px">${esc(d.reason || '')}</span></div>`;
  }
  const u = d.usageDetail;
  const fu = d.firstUsageDetail;
  const cacheHitPct = (ud) => { const t = (ud.input || 0) + (ud.cache_read || 0) + (ud.cache_creation || 0); return t > 0 ? Math.round(ud.cache_read / t * 100) : 0; };
  // 首次 loop 的数据（无多轮时退化为唯一一次）—— headline 与缓存色条统一锚到本轮首次循环
  const firstUd = fu || u;
  const ctxTokens = firstUd ? (firstUd.input || 0) + (firstUd.cache_read || 0) + (firstUd.cache_creation || 0) : d.realCtxTokens;
  const usageLine = firstUd
    ? `= cache_read ${fmt(firstUd.cache_read)} + cache_creation ${fmt(firstUd.cache_creation)} + input ${fmt(firstUd.input)}`
    : '(尚无 usage 记录)';
  const cacheRow = firstUd ? (() => {
    const hitPct = cacheHitPct(firstUd);
    const hitTok = fmt(firstUd.cache_read);
    const newTok = fmt(firstUd.cache_creation);
    return `<span class="ctxi-cache-nums">首次命中 ${hitTok} <b>(${hitPct}%)</b> · 本轮新增 ${newTok}</span>`;
  })() : '';
  // 数据来源:真抓包(wb-claude 进程内代理落盘的真实请求体) / 灵快照(wear 落盘的末轮请求体) / 从 jsonl 重建
  const srcTag = d.source === 'capture'
    ? `<span style="color:#1a7f37">🟢 真抓包${d.capturedAt ? ' · ' + new Date(d.capturedAt).toLocaleString('zh-CN', { hour12: false }) : ''}${d.bodyBytes ? ' · ' + fmt(d.bodyBytes) + ' B' : ''}</span>`
    : d.source === 'ling-prev'
      ? '<span style="color:#1a7f37">🟢 灵快照（末轮真实请求体）</span>'
      : `<span style="color:#9a6700">🟡 重建（无抓包数据）</span>`;
  const bar = d.breakdown.map(b => `<span style="width:${b.pct}%;background:${catColor(b.cat)}" title="${esc(b.cat)} ${b.pct}%"></span>`).join('');
  const legend = d.breakdown.map(b => `<span><i style="background:${catColor(b.cat)}"></i>${esc(b.cat)} ${b.pct}%</span>`).join('');
  // 物理序唯一视图:先算缓存判定(上浮前端,后端只切块+透传),再渲染。
  // 有 prevSigs 走 turn-first↔prev 前缀 diff,无则退回按 cache_read 累加的 approx 兜底。
  const secs = d.sections;
  const diffMode = computeCacheStates(secs, d.prevSigs, (firstUd && firstUd.cache_read) || 0);
  const modeTag = diffMode
    ? '<span class="ctxi-cache-mode" title="本轮首轮 ↔ 上一轮末态 逐块前缀 diff">精确 diff</span>'
    : '<span class="ctxi-cache-mode" title="无前锚,按 cache_read 累加估算">估算兜底</span>';
  const cacheLegend = `
    <div class="ctxi-legend ctxi-cache-legend">
      <span><i style="background:#1a7f37"></i>🟢 命中前缀</span>
      <span><i style="background:#0969da"></i>🔵 断点后新增</span>
      ${modeTag}
      ${cacheRow}
    </div>`;

  const blocks = overviewCard(secs) + secs.map(blockHtml).join('');

  return `
    <div class="ctxi-big">${fmt(ctxTokens)} <span style="font-size:14px;color:#57606a;font-weight:400">tokens</span></div>
    <div class="ctxi-sub">${srcTag}　当前上下文真实占用(来自本轮首次循环 usage)　${esc(usageLine)}${d.truncated ? '　· ⚠️ jsonl 过大已截断尾部' : ''}</div>
    <div class="ctxi-bar">${bar}</div>
    <div class="ctxi-legend">${legend}</div>
    ${cacheLegend}
    ${blocks}
  `;
}

export default {
  id: 'ctx-inspector',
  slot: 'chat.header.right',
  page: 'chat',
  order: 25,
  _overlay: null,
  _onKey: null,
  _onCtxClick: null,
  _notes: [],   // 暂存批注 {badge,title,quote,text,blk}

  mount() {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const ctxEl = $('#term-ctx');
    if (ctxEl) {
      ctxEl.title = '点击查看上下文检视器';
      this._onCtxClick = () => this._open();
      ctxEl.addEventListener('click', this._onCtxClick);
    }
  },

  unmount() {
    this._close();
    const ctxEl = $('#term-ctx');
    if (ctxEl && this._onCtxClick) ctxEl.removeEventListener('click', this._onCtxClick);
  },

  _open() {
    const id = state.currentTerminalId;
    if (!id) return;
    this._close();
    const ov = document.createElement('div');
    const theme = localStorage.getItem('ctxi-theme') === 'light' ? 'light' : 'dark';
    ov.className = 'ctxi-overlay' + (theme === 'dark' ? ' ctxi-dark' : '');
    ov.innerHTML = `<div class="ctxi-panel">
      <div class="ctxi-head"><span class="ctxi-title">🔬 上下文检视器</span>
        <button class="ctxi-theme" title="切换深/浅主题">${theme === 'dark' ? '☀️' : '🌙'}</button>
        <button class="ctxi-close" title="关闭 (Esc)">✕</button></div>
      <div class="ctxi-body"><div class="ctxi-msg">加载中…</div></div>
      <div class="ctxi-foot" hidden>
        <span class="ctxi-foot-msg" hidden></span>
        <button class="ctxi-submit"></button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    this._overlay = ov;
    this._notes = [];

    ov.addEventListener('click', (e) => { if (e.target === ov) this._close(); });
    ov.querySelector('.ctxi-close').addEventListener('click', () => this._close());
    // 深/浅主题切换：即时 toggle class + 记忆到 localStorage(室内深色/室外浅色)
    ov.querySelector('.ctxi-theme').addEventListener('click', (e) => {
      const dark = ov.classList.toggle('ctxi-dark');
      localStorage.setItem('ctxi-theme', dark ? 'dark' : 'light');
      e.currentTarget.textContent = dark ? '☀️' : '🌙';
    });
    const body = ov.querySelector('.ctxi-body');

    // 段落级批注：悬停微高亮提示可点，点击段落直接展开编辑器（见下方 click 处理）
    this._hoverPara = null;
    const clearHover = () => {
      this._hoverPara?.classList.remove('ctxi-para-hover');
      this._hoverPara = null;
    };
    // 从 target 上溯到 .ctxi-body-text 的直接子元素，即"这一段"
    const paraOf = (target) => {
      const bt = target.closest?.('.ctxi-body-text');
      if (!bt) return null;
      let el = target;
      while (el && el.parentElement !== bt) el = el.parentElement;
      return (el && el.nodeType === 1 && !el.classList.contains('ctxi-note-ed')) ? el : null;
    };
    body.addEventListener('mouseover', (e) => {
      if (e.target.closest('.ctxi-note-ed')) return;
      const para = paraOf(e.target);
      if (para === this._hoverPara) return;
      clearHover();
      if (!para) return;
      this._hoverPara = para;
      para.classList.add('ctxi-para-hover');
    });

    // 划词引用(整块💬路径)：click 会清掉选区，在 pointerdown 时先抓——仅当选区落在本块正文里才算
    body.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.ctxi-note-btn');
      const blk = btn?.closest('.ctxi-blk');
      if (!blk) return;
      const sel = window.getSelection();
      const txt = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      blk._quote = (txt && blk.querySelector('.ctxi-body-text').contains(sel.anchorNode)) ? txt : '';
    });
    // 打开批注编辑器：就地展开 + 写入引用预览
    const openEditor = (blk, anchorAfter) => {
      const ed = blk.querySelector('.ctxi-note-ed');
      const q = ed.querySelector('.ctxi-note-q');
      const quote = blk._quote || '';
      q.hidden = !quote;
      if (quote) q.textContent = `引用：「${quote.length > 200 ? quote.slice(0, 200) + '…' : quote}」`;
      anchorAfter.after(ed);
      ed.hidden = false;
      ed.querySelector('textarea').focus();
    };
    body.addEventListener('click', (e) => {
      // 概览卡锚点：平滑滚动到目标块 + 短暂闪烁高亮
      const nav = e.target.closest('.ctxi-nav');
      if (nav) {
        e.stopPropagation();
        const tgt = nav.dataset.target && body.querySelector('#' + (window.CSS?.escape ? CSS.escape(nav.dataset.target) : nav.dataset.target));
        if (tgt) {
          tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tgt.classList.remove('ctxi-flash');
          void tgt.offsetWidth;            // 重排以重启动画
          tgt.classList.add('ctxi-flash');
        }
        return;
      }
      const noteBtn = e.target.closest('.ctxi-note-btn');
      if (noteBtn) {                                  // 整块批注：编辑器回到块尾
        e.stopPropagation();
        const blk = noteBtn.closest('.ctxi-blk');
        openEditor(blk, blk.querySelector('.ctxi-body-text'));   // 编辑器回到块尾(原位)
        return;
      }
      if (e.target.closest('.ctxi-note-cancel')) {
        const ed = e.target.closest('.ctxi-note-ed');
        ed.hidden = true; ed.querySelector('textarea').value = '';
        return;
      }
      if (e.target.closest('.ctxi-note-save')) {      // 暂存批注
        const ed = e.target.closest('.ctxi-note-ed');
        const blk = ed.closest('.ctxi-blk');
        const text = ed.querySelector('textarea').value.trim();
        if (!text) return;
        this._notes.push({
          badge: blk.dataset.badge, title: blk.dataset.title,
          quote: blk._quote || '', text, blk,
        });
        ed.hidden = true; ed.querySelector('textarea').value = ''; blk._quote = '';
        const cnt = blk.querySelector('.ctxi-note-cnt');
        cnt.textContent = this._notes.filter(n => n.blk === blk).length;
        cnt.hidden = false;
        this._updateFoot(ov);
        return;
      }
      // 点正文任一段 → 直接展开编辑器（少一步）；划词松手也是一次点击，选区优先作引用
      // 概览卡无批注编辑器,排除掉(否则 openEditor 取不到 .ctxi-note-ed 报错)
      const para = paraOf(e.target);
      if (para && !para.closest('.ctxi-overview')) {
        const blk = para.closest('.ctxi-blk');
        const sel = window.getSelection();
        const stxt = sel && !sel.isCollapsed && blk.querySelector('.ctxi-body-text').contains(sel.anchorNode)
          ? sel.toString().trim() : '';
        const ptxt = (para.textContent || '').trim().replace(/\s+/g, ' ');
        blk._quote = stxt || (ptxt.length > 300 ? ptxt.slice(0, 300) + '…' : ptxt);
        openEditor(blk, para);
        return;
      }
      const hd = e.target.closest('.ctxi-hd');        // 折叠/展开：点 header 切换
      if (hd) hd.parentElement.classList.toggle('open');
    });
    ov.querySelector('.ctxi-submit').addEventListener('click', () => this._submitNotes(ov, id));
    this._onKey = (e) => { if (e.key === 'Escape') this._close(); };
    document.addEventListener('keydown', this._onKey);

    fetch(`${BASE_PATH}/api/actors/${encodeURIComponent(id)}/context`)
      .then(r => r.json())
      .then(d => {
        if (this._overlay !== ov) return;   // 期间已关
        body.innerHTML = renderData(d);
      })
      .catch(err => {
        if (this._overlay !== ov) return;
        ov.querySelector('.ctxi-body').innerHTML = `<div class="ctxi-msg">加载失败<br><span style="font-size:12px">${esc(err.message || '')}</span></div>`;
        this.health?.('yellow', err.message);
      });
  },

  _updateFoot(ov) {
    const foot = ov.querySelector('.ctxi-foot');
    const btn = foot.querySelector('.ctxi-submit');
    foot.hidden = !this._notes.length;
    btn.textContent = `提交 ${this._notes.length} 条批注`;
    btn.disabled = false;
    foot.querySelector('.ctxi-foot-msg').hidden = true;
  },

  // 把暂存批注拼成一条 markdown，经 user_msg 发进该终端（聊天流里同步出气泡）
  _submitNotes(ov, id) {
    if (!this._notes.length) return;
    const md = ['【上下文批注】来自上下文检视器', ''];
    this._notes.forEach((n, i) => {
      md.push(`### ${i + 1}. ${n.badge} · ${n.title}`);
      if (n.quote) md.push(`> 引用：「${n.quote}」`, '');
      md.push(n.text, '');
    });
    const text = md.join('\n');
    const btn = ov.querySelector('.ctxi-submit');
    btn.disabled = true; btn.textContent = '发送中…';
    const time = timeNow();
    sendMessage(id, 'user_msg', { text }).then(resp => {
      state.archiveSelfMessage(id, resp?.id, 'user_msg', { text });
      pushEvent(id, { time, action: 'user_message', detail: text, msgId: resp?.id });
      this._notes = [];
      btn.hidden = true;
      const msg = ov.querySelector('.ctxi-foot-msg');
      msg.textContent = '✓ 已发进终端';
      msg.hidden = false;
      // 发完即返回聊天流——短暂展示 ✓ 后自动关检视器
      setTimeout(() => { if (this._overlay === ov) this._close(); }, 700);
    }).catch(err => {
      btn.disabled = false; btn.textContent = `提交 ${this._notes.length} 条批注（失败重试）`;
      this.health?.('yellow', err.message);
    });
  },

  _close() {
    if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }
    this._notes = [];
    this._hoverPara = null;
  },
};
