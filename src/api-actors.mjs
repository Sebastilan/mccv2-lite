// api-actors.mjs — /api/actors + /api/messages + /api/providers + /api/actors/:id/context 端点
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { obs } from './observability.mjs';
import { getAll, resolveByModel, resolveContextWindow } from './providers/_registry.mjs';
import { touchRecentProject } from './api/projects.mjs';
import { WORKSPACE_ROOT } from './config.mjs';
import { INJECT_MARKERS, isGitStatusBlock } from './scanners/inject-markers.mjs';

function getProviders() {
  return getAll();
}

function resolveProviderEnv(model) {
  const { providerEnv = {} } = resolveByModel(model);
  const extra = Object.keys(providerEnv).length ? { providerEnv } : {};
  const contextWindow = resolveContextWindow(model);
  return contextWindow ? { ...extra, contextWindow } : extra;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function patchMeta(bus, actorId, updates) {
  const row = bus.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
  if (!row) return null;
  const meta = JSON.parse(row.meta || '{}');
  Object.assign(meta, updates);
  bus.db.prepare('UPDATE actors SET meta=?, last_seen=? WHERE id=?')
    .run(JSON.stringify(meta), Date.now(), actorId);
  return bus.db.prepare('SELECT * FROM actors WHERE id=?').get(actorId);
}

/**
 * Actor 入库 + 公示的共享路径：所有 kind 的 createXxxActor 走这条。
 * 1) INSERT actors 行（idle 状态）
 * 2) poolSupervisor.notifyNewActor + broadcast
 * 3) emit `created` event 消息（前端从这里知道 actor 就位）
 * 4) 如带 task，插入初始 user_msg
 * 5) obs counter
 * 返回 actorId。kind 校验/meta 预处理由调用方负责。
 */
function insertAndAnnounceActor({ kind, idPrefix, meta, task, bus, poolSupervisor, broadcaster }) {
  const now = Date.now();
  const actorId = `${idPrefix}_${now}`;
  bus.db.prepare(
    'INSERT OR REPLACE INTO actors (id, kind, status, meta, created_at, last_seen) VALUES (?,?,?,?,?,?)'
  ).run(actorId, kind, 'idle', JSON.stringify(meta), now, now);
  const actor = bus.db.prepare('SELECT * FROM actors WHERE id=?').get(actorId);
  poolSupervisor.notifyNewActor(actor);
  broadcaster?.broadcastActorUpdate(actor);
  // V2 lazy spawn 无"真就绪"信号（adapter 收到首条 user_msg 才发 session_init），
  // 所以 created 事件即"actor 行已就位、可接消息"，时机就是 INSERT 完成那一刻。
  const projectName = path.basename(meta.projectPath || '') || actorId;
  const createdPayload = { event_type: 'created', project: projectName };
  if (meta.resumedFrom) createdPayload.resumed = true;
  bus.insertMessage({ from_id: actorId, to_id: 'human_self', kind: 'event', payload: createdPayload, ts: now });
  if (typeof task === 'string' && task.trim()) {
    bus.insertMessage({ from_id: 'human_self', to_id: actorId, kind: 'user_msg', payload: { text: task.trim() }, ts: Date.now() });
  }
  obs.counter('actors.created');
  return actorId;
}

/**
 * 创建 cc kind actor 的唯一可信路径（POST /api/actors 和 history resume 共用）
 * 返回 { ok, actorId, error?, code? }；调用方据 ok 决定 HTTP 响应。
 */
export function createCcActor({ meta = {}, bus, poolSupervisor, broadcaster }) {
  // 语义护栏（handler 与 history resume 路径共用，防历史翻车 6+ 类里的"静默僵尸"）：
  // C. meta.prompt 不是任务字段。用它派会造出在册、type=worker 但收 0 消息、永不动手的空转终端（2026-06-14 实证）。
  if (meta.prompt !== undefined) {
    return { ok: false, error: 'meta.prompt 不被使用，你是不是想用 meta.task？', code: 400 };
  }
  // D. type=worker 漏 callbackActorId：无处回报，且反嵌套/driver 继承全部失效 → 名义 worker、实为脱缰终端。
  if (meta.type === 'worker' && !meta.callbackActorId) {
    return { ok: false, error: 'type=worker 必须带 meta.callbackActorId', code: 400 };
  }
  // 反嵌套校验：worker 不能派 worker（callback 必须指向存活的 advisor）
  let advMeta = null;
  if (meta.callbackActorId) {
    const adv = bus.db.prepare('SELECT meta, status FROM actors WHERE id=?').get(meta.callbackActorId);
    if (!adv || adv.status === 'gone') {
      return { ok: false, error: 'callback actor not found or gone', code: 400 };
    }
    try { advMeta = JSON.parse(adv.meta || '{}'); } catch { advMeta = {}; }
    if (advMeta.callbackActorId) {
      return { ok: false, error: 'workers cannot spawn workers (anti-nesting)', code: 400 };
    }
  }
  // type=worker：自动从 advisor 的 bin 派生 wb-worker.mjs，无需调用方填路径
  if (meta.type === 'worker' && !meta.bin && advMeta?.bin) {
    meta = { ...meta, bin: path.join(path.dirname(advMeta.bin), 'wb-worker.mjs') };
  }
  // driver 继承：worker 未显式指定 driver 时随父——父走 PTY（订阅额度），
  // 派出的 worker 也走 PTY，整条链路吃订阅额度而非掉回 --print 烧 API credit。
  // payload 显式带 driver 仍覆盖（!meta.driver 守门）。
  if (!meta.driver && advMeta?.driver) {
    meta = { ...meta, driver: advMeta.driver };
  }
  // 傻瓜式:不选路径,新终端默认都落在共用工作区(MCC_WORKSPACE);要分目录由 AI 自己在里面建(见 process.mjs 预加载)
  if (!meta.projectPath) meta = { ...meta, projectPath: WORKSPACE_ROOT };
  const fullMeta = { ...meta, ...resolveProviderEnv(meta.model) };
  if (!['main', 'aux', 'auto'].includes(fullMeta.advisorType)) delete fullMeta.advisorType;
  const actorId = insertAndAnnounceActor({
    kind: 'cc', idPrefix: 'cc', meta: fullMeta, task: meta.task,
    bus, poolSupervisor, broadcaster,
  });
  touchRecentProject(path.basename(meta.projectPath || ''));
  return { ok: true, actorId };
}

/**
 * 创建 chat kind actor（「慢聊」最小 agent：read/write/edit_file + web_search + now/whereami）。
 * stdio v1 原生 adapter（adapters/chat/chat.mjs）：deepseek-* 直连 DeepSeek 官方端点，
 * 其余走 PROVIDER_CHAT_URL 指向的任意 Anthropic 兼容网关。不需要 providerEnv。
 * 默认 model=deepseek-v4-flash（快 + 关思考）——与前端 CHAT_MODELS[0] 同档，
 * 二者都改才算真换默认（前端管弹窗首选项，这里管 ghost 占位卡 / API 直建）。
 */
export function createChatActor({ meta = {}, bus, poolSupervisor, broadcaster }) {
  const fullMeta = { model: 'deepseek-v4-flash', ...meta };
  const actorId = insertAndAnnounceActor({
    kind: 'chat', idPrefix: 'chat', meta: fullMeta, task: meta.task,
    bus, poolSupervisor, broadcaster,
  });
  return { ok: true, actorId };
}

/**
 * 创建 codex kind actor（OpenAI Codex CLI，adapters/codex/codex.mjs，每轮 `codex exec --json`）。
 * model 留空 = 按本机 codex 配置；不需要 providerEnv，登录态用 `codex login`。
 */
export function createCodexActor({ meta = {}, bus, poolSupervisor, broadcaster }) {
  const fullMeta = { ...meta, projectPath: meta.projectPath || WORKSPACE_ROOT };
  const actorId = insertAndAnnounceActor({
    kind: 'codex', idPrefix: 'codex', meta: fullMeta, task: meta.task,
    bus, poolSupervisor, broadcaster,
  });
  return { ok: true, actorId };
}

/**
 * 创建 life kind actor（傻循环：一只手 run(shell)，adapters/life/life.mjs → basic.py）。
 * model 留空 = 按 .env（LIFE_* / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY），见 adapters/life/life.mjs 头注。
 */
export function createLifeActor({ meta = {}, bus, poolSupervisor, broadcaster }) {
  const fullMeta = { ...meta, projectPath: meta.projectPath || WORKSPACE_ROOT };
  const actorId = insertAndAnnounceActor({
    kind: 'life', idPrefix: 'life', meta: fullMeta, task: meta.task,
    bus, poolSupervisor, broadcaster,
  });
  return { ok: true, actorId };
}

// kind → 创建函数路由（加新终端种类时只需新建 createXxxActor + 这里加一行）
const ACTOR_CREATORS = {
  cc: createCcActor,
  chat: createChatActor,
  codex: createCodexActor,
  life: createLifeActor,
};

// ─────────────────────────────────────────────────────────────────────────
// 上下文检视器：纯读 CC CLI 落盘的 session jsonl，摊开成「上下文里装了什么」
// 逻辑端口自 tmp/probe/ctx-inspect.py。零写入、零副作用，绝不碰 bus.db。
// ─────────────────────────────────────────────────────────────────────────
const CTX_MAX_BYTES = 50 * 1024 * 1024;   // >50MB 只读尾部并标注 truncated

// INJECT_MARKERS（注入块行首标题清单，单一事实源）现由 scanners/inject-markers.mjs 导出，见顶部 import。

// 命中 memex 模块的 Read 路径：.../memex/**.md 或 .../.memex/**.md
const MEMEX_PATH_RE = /[/\\]\.?memex[/\\].*\.md$/i;

// 粗估 token：CJK ~1 tok/字，其余 ~4 char/tok。仅供占比展示，不当账。
function estTok(s) {
  if (!s) return 0;
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

// session jsonl 不含 tools+system 原文（CC CLI 内部拼装），但它们排在真实请求最前面。
// 抓包快照存档于此目录，用来在检视器最前合成一块占位（不落盘、仅供参考）。
const WIRE_SNAPSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'wire-snapshots');

// isGitStatusBlock（首条 user 的某 block 是否为 gitStatus/环境 system-reminder）现由 inject-markers.mjs 导出。

// 合成「tools + system」占位块：从 data/wire-snapshots 的抓包快照里提取 tools 名单 + system 原文。
// 没有快照时退化为固定估算并在 body 注明。返回 section（category='system'），由调用方塞到 sections 最前。
function buildSystemSection() {
  let snapPath = null, meta = {};
  try {
    const files = fs.readdirSync(WIRE_SNAPSHOT_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
    const pick = files.includes('cc-request-sample.json') ? 'cc-request-sample.json' : files[0];
    if (pick) {
      snapPath = path.join(WIRE_SNAPSHOT_DIR, pick);
      const metaPath = path.join(WIRE_SNAPSHOT_DIR, pick.replace(/\.json$/, '.meta.json'));
      if (fs.existsSync(metaPath)) { try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* ignore */ } }
    }
  } catch { /* 目录不存在 */ }

  if (!snapPath) {
    const body = [
      '> 📸 此块为**合成占位**——tools 与 system 由 CC CLI 内部拼装，不写入 session jsonl。',
      '> 当前仓内 `data/wire-snapshots/` 无快照，下列为**固定估算值**（非实测）。',
      '',
      '- **tools**：~31 个工具 schema，共 ~24,000 chars ≈ ~6,000 tok（估算）',
      '- **system**：计费头 + SDK 身份 + 主提示(含基因块) 共 ~7,000 chars ≈ ~2,500 tok（估算）',
    ].join('\n');
    return { id: 'sys0', category: 'system', title: '🔒 tools + system（不落盘，估算）', tok: 8500, body };
  }

  let j = {};
  try { j = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch { /* 用空对象兜底 */ }
  const tools = Array.isArray(j.tools) ? j.tools : [];
  const sys = Array.isArray(j.system) ? j.system : [];
  const toolsStr = JSON.stringify(tools);
  const toolsTok = estTok(toolsStr);
  const sysLabels = ['计费头', 'SDK 身份', '主提示 + 基因块'];
  let sysTok = 0;
  const sysParts = sys.map((s, i) => {
    const txt = s.text || '';
    sysTok += estTok(txt);
    return `### system[${i}] · ${sysLabels[i] || `段 ${i}`}（${txt.length} chars）\n\n\`\`\`\n${txt}\n\`\`\``;
  });
  const body = [
    '> 📸 此块为**合成占位**——tools 与 system 由 CC CLI 内部拼装，不写入 session jsonl，无法从本终端会话还原。',
    `> 下列取自快照：${meta.source || path.basename(snapPath)}`,
    `> （采集 ${meta.capturedAt || '时间未知'}${meta.ccVersion ? `，CC ${meta.ccVersion}` : ''}）。不同 actor 的工具集 / 基因可能不同，仅作代表性参考。`,
    '',
    `## tools（${tools.length} 个，schema 共 ${toolsStr.length} chars ≈ ${toolsTok.toLocaleString('en-US')} tok）`,
    tools.map(t => `- \`${t.name}\``).join('\n') || '_(快照无 tools)_',
    '',
    '## system',
    '',
    sysParts.join('\n\n') || '_(快照无 system)_',
  ].join('\n');
  return {
    id: 'sys0', category: 'system',
    title: '🔒 tools + system（不落盘，快照）',
    tok: toolsTok + sysTok, body,
  };
}

// CC CLI 把 workDir 路径里非字母数字字符全替换成 '-'（/srv/work/demo → -srv-work-demo）
function locateSessionFile(projectPath, sessionId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (projectPath) {
    const enc = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const p = path.join(base, enc, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  // 兜底：projectPath 缺失/编码不匹配时，按 sessionId（UUID 全局唯一）扫各项目目录
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* base 不存在 */ }
  return null;
}

function readSessionRows(file) {
  const st = fs.statSync(file);
  let raw, truncated = false;
  if (st.size > CTX_MAX_BYTES) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CTX_MAX_BYTES);
    fs.readSync(fd, buf, 0, CTX_MAX_BYTES, st.size - CTX_MAX_BYTES);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
    raw = raw.slice(raw.indexOf('\n') + 1);   // 丢掉被截断的首行残片
    truncated = true;
  } else {
    raw = fs.readFileSync(file, 'utf8');
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return { rows, truncated };
}

// 纯函数：把 session jsonl 的 rows 摊平成 sections[]（每块 {id,category,title,tok,body}）
// 同时累计 cats（中文分类名→tok，用于占比 breakdown）。逻辑与原 buildContext 内联循环一致。
// 抽出来是为了能用「上一轮请求的 rows」重跑一遍，做缓存前缀 diff。
function rowsToSections(rows, memexIds) {
  const cats = {};
  const sections = [];
  const addCat = (k, t) => { cats[k] = (cats[k] || 0) + t; };
  const push = (category, title, tok, body) => {
    sections.push({ id: `s${sections.length}`, category, title, tok, body: body || '' });
  };

  let firstUserDone = false;
  for (const o of rows) {
    if (o.type !== 'user' && o.type !== 'assistant') {
      // role=system 等中途注入(文件改动提示 / 后台事件通知 / 工具系统消息)——物理位置保持原位、内容不丢
      const mm = o.message;
      const cc = (mm && typeof mm === 'object') ? mm.content : (typeof o.content === 'string' ? o.content : null);
      const txt = typeof cc === 'string' ? cc
        : Array.isArray(cc) ? cc.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '';
      if (txt) { const tk = estTok(txt); addCat('注入·系统提醒', tk); push('inject', `⚙️ 系统注入(role=${o.type || '?'})`, tk, txt); }
      continue;
    }
    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const cont = m.content;

    // 第一条 user：平台注入大块。逐 content block 处理以贴合真实物理排布——
    // gitStatus/环境 的 system-reminder 单列成块；含 marker 的块按 INJECT_MARKERS 切层；
    // 其余无 marker 块即本轮用户消息（或其它系统提醒）。
    if (role === 'user' && !firstUserDone) {
      firstUserDone = true;
      // 保留原始 block(含非文本),逐块按物理序处理:文本走 marker 切层,非文本兜底成 ❓ 未知块
      const rawBlocks = typeof cont === 'string'
        ? [{ type: 'text', text: cont }]
        : Array.isArray(cont) ? cont : [];
      // 把含 INJECT_MARKERS 的一段文本按 marker 切层并 push；命中返回 true
      const splitByMarkers = (text) => {
        const idxs = [];
        for (const [mk, lab] of INJECT_MARKERS) {
          // 锚定行首标题形态「\n【marker」（部分块用〔〕括号）——正文中段引用（如对话里转述 marker 词）不误命中
          const m = new RegExp(`(?:^|\\n)[【〔]${mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text);
          if (m) idxs.push([m.index + (m[0].startsWith('\n') ? 1 : 0), mk, lab]);
        }
        idxs.sort((a, b) => a[0] - b[0]);
        if (!idxs.length) return false;
        // 首个 marker 之前若有大段内容（环境/系统提示残留），单独成块
        const lead = text.slice(0, idxs[0][0]).trim();
        if (lead.length > 200) {
          const tk = estTok(lead); addCat('注入·环境/系统', tk);
          push('inject', '⚙️ 环境 / 系统提示', tk, lead);
        }
        for (let i = 0; i < idxs.length; i++) {
          const p = idxs[i][0];
          const end = i + 1 < idxs.length ? idxs[i + 1][0] : undefined;
          const seg = end !== undefined ? text.slice(p, end) : text.slice(p);
          const tk = estTok(seg); addCat('注入·基因/地图/摘要', tk);
          push('inject', idxs[i][2], tk, seg);
        }
        return true;
      };
      for (const blk of rawBlocks) {
        if (!blk || typeof blk !== 'object') continue;
        if (blk.type !== 'text') {
          // 首条 user 里的非文本块(图片 / document 等)也不静默丢弃,原始 JSON 逐字计入、保物理位
          const s = JSON.stringify(blk); const tk = estTok(s);
          addCat('未知块', tk); push('unknown', `❓ 未知块(${blk.type || '?'})`, tk, s);
          continue;
        }
        const t = blk.text || '';
        if (!t || !t.trim()) continue;
        if (isGitStatusBlock(t)) {
          const tk = estTok(t); addCat('注入·gitStatus/环境', tk);
          push('inject', '⚙️ gitStatus / 环境', tk, t);
          continue;
        }
        if (splitByMarkers(t)) continue;
        const tk = estTok(t);
        if (/<system-reminder>/.test(t)) {
          addCat('注入·系统提醒', tk);
          push('inject', '⚙️ 系统提醒', tk, t);
        } else {
          addCat('用户消息', tk);
          push('user', '💬 本轮用户消息', tk, t);
        }
      }
      continue;
    }

    // 后续轮次
    if (!Array.isArray(cont)) {
      if (typeof cont === 'string' && role === 'user') {
        const tk = estTok(cont);
        addCat('用户消息', tk);
        push('user', '用户消息', tk, cont);
      }
      continue;
    }
    for (const b of cont) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking') {
        const s = b.thinking || '';
        if (!s) continue;
        const tk = estTok(s); addCat('思考', tk); push('think', 'assistant 思考', tk, s);
      } else if (b.type === 'text') {
        const s = b.text || '';
        const tk = estTok(s); addCat('助手正文', tk); push('asst', '正文', tk, s);
      } else if (b.type === 'tool_use') {
        const s = JSON.stringify(b.input || {});
        const tk = estTok(s);
        if (memexIds.has(b.id)) {
          // memex Read 的调用块:input JSON 也逐字计入、物理位置保持原位(结果在其 tool_result 处)
          const name = memexIds.get(b.id).split(/[/\\]/).pop();
          addCat('memex 召回', tk); push('memex-call', `🧠 调用 ${name}`, tk, s);
        } else {
          addCat('工具调用', tk); push('tooluse', `工具调用: ${b.name || '?'}`, tk, s);
        }
      } else if (b.type === 'tool_result') {
        let c = b.content;
        if (Array.isArray(c)) c = c.map(x => (x && typeof x === 'object') ? (x.text || '') : String(x)).join(' ');
        c = c == null ? '' : String(c);
        if (memexIds.has(b.tool_use_id)) {
          const name = memexIds.get(b.tool_use_id).split(/[/\\]/).pop();
          const tk = estTok(c); addCat('memex 召回', tk); push('memex', `🧠 ${name}`, tk, c);
        } else {
          const tk = estTok(c); addCat('工具结果', tk); push('toolres', '工具结果', tk, c);
        }
      } else {
        // 未知 block 类型(image / redacted_thinking / document 等)兜底渲染,不静默丢弃——原始 JSON 逐字计入
        const s = JSON.stringify(b);
        const tk = estTok(s); addCat('未知块', tk); push('unknown', `❓ 未知块(${b.type || '?'})`, tk, s);
      }
    }
  }
  return { sections, cats };
}

// 合成「gitStatus / 环境」占位块。CC CLI 把 gitStatus+环境 system-reminder 注入到 wire 请求
// 首条 user 之前(系统提示之后)，但**不落 session jsonl**(实测各终端 jsonl 首条 user 都无此块)。
// 故这里按 actor 的 projectPath 实时读 git 状态 + CC 原版模板重建,标注为合成、非 jsonl。
// 会话开始时的快照值可能与当下略有出入(reminder 本身声明"git status at the start of the conversation")。
function buildGitStatusSection(meta) {
  const cwd = meta.projectPath;
  if (!cwd || !fs.existsSync(cwd)) return null;
  const git = (args) => {
    try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return null;   // 非 git 仓 / git 不可用 → 不合成
  const user = git(['config', 'user.name']);
  const st = git(['status', '--porcelain']);
  const log = git(['log', '-5', '--format=%h %s']);
  const reminder = [
    '<system-reminder>',
    'As you answer the user\'s questions, you can use the following context:',
    '# gitStatus',
    'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
    '',
    `Current branch: ${branch}`,
    '',
    'Main branch (you will usually use this for PRs): master',
    '',
    `Git user: ${user || '?'}`,
    '',
    'Status:',
    st || '(clean)',
    '',
    'Recent commits:',
    log,
    '# Environment',
    `Primary working directory: ${cwd}`,
    ` - Platform: ${process.platform}`,
    '</system-reminder>',
  ].join('\n');
  const body = '> 📸 此块为**合成占位**——gitStatus/环境 reminder 由 CC CLI 注入 wire 请求但不写入 session jsonl，'
    + '下列按当前仓库实时重建（会话开始时的值可能略有出入）。\n\n```\n' + reminder + '\n```';
  return { id: 'git0', category: 'system', title: '⚙️ gitStatus / 环境（不落盘，合成）', tok: estTok(reminder), body };
}

// per-terminal 抓包文件路径。wb-claude 进程内代理把每轮真实请求体覆盖式落盘到
// $MEMEX_STATE_DIR/<actorId>/last-request.json(缺省 ~/.cache/memex/actors/<actorId>/),
// 路径推导与 wb-claude.mjs 一致。
function captureFilePath(actorId) {
  if (!actorId) return null;
  const base = process.env.MEMEX_STATE_DIR || path.join(os.homedir(), '.cache', 'memex', 'actors');
  return path.join(base, actorId, 'last-request.json');
}

// 抓包请求体 → sections(+cats)。system[] 各项 + tools 各成块,messages[] 复用 rowsToSections
// (与 jsonl 重建同一套切块/marker/memex 逻辑,贴合真实物理序)。同构用于当前与 prev 两份抓包。
export function captureBodyToSections(body) {
  const cats = {};
  const addCat = (k, t) => { cats[k] = (cats[k] || 0) + t; };
  const sections = [];

  // system 数组各项成块(category=system,与重建占位同色)。原文逐字进 code fence,保「一字对应」。
  let sys = Array.isArray(body.system) ? body.system : [];
  // body.system 为整段字符串形态(部分 CC 版本)时兜底成单块,避免整段 system 静默丢失
  if (!sys.length && typeof body.system === 'string' && body.system.trim()) {
    sys = [{ text: body.system, _label: 'system(整段字符串)' }];
  }
  const sysLabels = ['计费头', 'SDK 身份', '主提示 + 基因块'];
  sys.forEach((s, i) => {
    const txt = s?.text || (typeof s === 'string' ? s : '');
    const tk = estTok(txt); addCat('系统·system', tk);
    const label = s?._label || sysLabels[i] || `段 ${i}`;
    sections.push({ category: 'system', title: `🔒 system[${i}] · ${label}（${txt.length} chars）`, tok: tk, body: '```\n' + txt + '\n```' });
  });
  // tools 成块:顶部工具名清单做摘要 + 逐字 schema JSON(前端默认折叠),保「一字对应」物理保真
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length) {
    const toolsStr = JSON.stringify(tools); const tk = estTok(toolsStr); addCat('系统·tools', tk);
    const summary = '工具清单：' + tools.map(t => t.name).join('、');
    const verbatim = '```json\n' + JSON.stringify(tools, null, 2) + '\n```';
    sections.push({ category: 'system', title: `🔒 tools（${tools.length} 个,schema ${toolsStr.length} chars）`, tok: tk, body: summary + '\n\n' + verbatim });
  }

  // messages 复用 rowsToSections:把 {role,content} 映射成 jsonl 行形状 {type:role, message}
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const memexIds = new Map();
  for (const m of msgs) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.name === 'Read') {
        const fp = (b.input || {}).file_path || '';
        if (MEMEX_PATH_RE.test(fp)) memexIds.set(b.id, fp);
      }
    }
  }
  const rows = msgs.map(m => ({ type: m.role, message: m }));
  const { sections: msgSecs, cats: msgCats } = rowsToSections(rows, memexIds);
  for (const [k, v] of Object.entries(msgCats)) addCat(k, v);
  for (const s of msgSecs) sections.push(s);
  sections.forEach((s, i) => { s.id = `s${i}`; });   // 统一重排 id,保唯一
  return { sections, cats };
}

// 块轻量签名:body 长度 + 标题。前后端必须用同一公式(前端 ctx-inspector.js 同款),
// 用于 turn-first(后锚) ↔ prev(前锚) 逐块前缀 diff。body 自等 → 长度+标题自等 → 命中。
function sectionSig(s) { return s.body.length + ':' + s.title; }

// 从真抓包请求体构建检视器响应。usage 取自 session jsonl(抓包体本身不含 usage):
//   ① 末条 usage  → headline 当前占用(realCtxTokens / usageDetail)
//   ② 本轮首次循环 usage → firstUsageDetail(前端 approx 冷启兜底用)
// 缓存色条判定全部上浮前端:后端只切块 + 透传 prevSigs(prev 抓包同构切块的逐块签名),
// 前端有 prevSigs 走前缀 diff,无则退回按 cache_read 累加的 approx。后端不再判定 cacheState。
function buildFromCapture(body, meta, cap, prevBody) {
  let realCtxTokens = 0, usageDetail = null, firstUsageDetail = null, turnFirstUsage = null;
  try {
    const f = meta.sessionId ? locateSessionFile(meta.projectPath, meta.sessionId) : null;
    if (f) {
      const { rows } = readSessionRows(f);
      // 本轮首次循环起点:最后一个真用户回合起点。回合起点 = type==='user' 且
      // content 是字符串,或是数组且含 type==='text' 块(纯 tool_result 续轮数组不算)。
      let turnStart = -1;
      for (let i = 0; i < rows.length; i++) {
        const o = rows[i];
        if (o.type !== 'user') continue;
        const c = (o.message && typeof o.message === 'object') ? o.message.content : null;
        const isTurnStart = typeof c === 'string'
          || (Array.isArray(c) && c.some(b => b && b.type === 'text'));
        if (isTurnStart) turnStart = i;
      }
      // 一趟扫出:全局首条(退化用) / 末条(headline) / 本轮首次循环(回合起点及其后第一条) usage
      let globalFirst = null, last = null, turnFirst = null;
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i].message;
        if (!m || typeof m !== 'object' || !m.usage) continue;
        if (!globalFirst) globalFirst = m.usage;
        last = m.usage;
        if (turnFirst === null && turnStart >= 0 && i >= turnStart) turnFirst = m.usage;
      }
      turnFirstUsage = turnFirst || globalFirst;   // 找不到回合起点(单轮/PTY)退化为全局首条
      const u = last;
      if (u) {
        realCtxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usageDetail = { input: u.input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0 };
        const fu = turnFirstUsage;
        if (fu && fu !== u) firstUsageDetail = { input: fu.input_tokens || 0, cache_read: fu.cache_read_input_tokens || 0, cache_creation: fu.cache_creation_input_tokens || 0 };
      }
    }
  } catch { /* 无 usage 不致命,headline 退化为 0 */ }

  const { sections, cats } = captureBodyToSections(body);

  // 前锚 prev(上一轮末态)同构切块 → 逐块签名,透传给前端做前缀 diff。无 prev(冷启/旧 wrapper)→ null。
  let prevSigs = null;
  if (prevBody) {
    try {
      const { sections: prevSections } = captureBodyToSections(prevBody);
      prevSigs = prevSections.map(sectionSig);
    } catch { prevSigs = null; }
  }

  // 色条/图例按 cats 插入序(=各分类物理首次出现序),与下方块清单顺序一致,不按 token 大小重排。
  const total = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
  const breakdown = Object.entries(cats)
    .map(([cat, tok]) => ({ cat, tok, pct: Math.round(tok / total * 100) }));

  return {
    available: true,
    source: 'capture',
    capturedAt: cap?.ts || null,
    bodyBytes: cap?.bodyBytes || null,
    realCtxTokens, usageDetail, firstUsageDetail, breakdown, sections, prevSigs,
    truncated: false, sessionId: meta.sessionId,
  };
}

// —— 灵终端上下文检视 ——
// 灵每轮 wear 时把「真实请求体」落盘到 {project}/conversations/：
//   <sessionId>_v0_prev.txt    末轮 system prompt 全文（穿戴后）
//   <sessionId>_msgs_prev.json 末轮 messages 数组（物理序 = 真实请求序）
// 直接读这两个文件切块展示（与 CC capture 路径同语义），零打扰灵本体。
export function buildLingContext(meta) {
  const sessionId = meta.sessionId;
  if (!sessionId) return { available: false, reason: '灵终端尚未运行（无 sessionId）' };
  const convDir = meta.projectPath
    ? path.join(meta.projectPath, 'conversations')
    : path.join(process.cwd(), 'conversations');
  const sysFile = path.join(convDir, `${sessionId}_v0_prev.txt`);
  const msgsFile = path.join(convDir, `${sessionId}_msgs_prev.json`);
  if (!fs.existsSync(sysFile) && !fs.existsSync(msgsFile)) {
    return { available: false, reason: '未找到灵的上下文快照（conversations/*_prev）——该会话还没跑完一轮' };
  }

  const cats = {};
  const sections = [];
  const addCat = (k, t) => { cats[k] = (cats[k] || 0) + t; };
  const push = (category, title, tok, body) => {
    sections.push({ id: `s${sections.length}`, category, title, tok, body: body || '' });
  };

  // system：穿戴后的完整 system prompt（基因+索引+记忆已拼好，物理序第一块）
  let sysText = '';
  try { sysText = fs.readFileSync(sysFile, 'utf8'); } catch { /* 缺失不致命 */ }
  if (sysText) {
    const tk = estTok(sysText);
    addCat('系统·穿戴 system', tk);
    push('system', '🔒 灵 system prompt（穿戴后全文）', tk, sysText);
  }

  // messages：物理序逐块铺开。content 可能是 string 或 content-block 数组。
  let msgs = [];
  try { msgs = JSON.parse(fs.readFileSync(msgsFile, 'utf8')); } catch { /* 损坏 → 只展示 system */ }
  if (!Array.isArray(msgs)) msgs = [];
  const firstLine = (t) => (t || '').trim().split('\n')[0].slice(0, 60) || '(空)';
  for (const m of msgs) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }]
      : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        const tk = estTok(b.text || '');
        if (m.role === 'user') { addCat('用户消息', tk); push('user', `👤 ${firstLine(b.text)}`, tk, b.text || ''); }
        else { addCat('助手正文', tk); push('asst', `🤖 ${firstLine(b.text)}`, tk, b.text || ''); }
      } else if (b.type === 'thinking') {
        const tk = estTok(b.thinking || '');
        addCat('思考', tk); push('think', '💭 thinking', tk, b.thinking || '');
      } else if (b.type === 'tool_use') {
        const body = JSON.stringify(b.input || {}, null, 2);
        const tk = estTok(body);
        addCat('工具调用', tk); push('tooluse', `🔧 ${b.name || 'tool'}`, tk, body);
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(x => x?.text || '').join('\n') : JSON.stringify(b.content || '');
        const tk = estTok(c);
        addCat('工具结果', tk); push('toolres', '📄 tool_result', tk, c);
      } else {
        const s = JSON.stringify(b); const tk = estTok(s);
        addCat('未知块', tk); push('unknown', `❓ ${b.type || '未知'}`, tk, s);
      }
    }
  }

  const total = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
  const breakdown = Object.entries(cats)
    .map(([cat, tok]) => ({ cat, tok, pct: Math.round(tok / total * 100) }));

  // headline：优先 meta.lastUsage（turn_done 的 context_usage 持久化，真数）；否则退字符估算
  const u = meta.lastUsage;
  const realCtxTokens = u
    ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    : total;
  return {
    available: true,
    source: 'ling-prev',
    realCtxTokens,
    usageDetail: u ? {
      input: u.input_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_creation: u.cache_creation_input_tokens || 0,
    } : null,
    firstUsageDetail: null,
    breakdown, sections, prevSigs: null,
    truncated: false, sessionId,
  };
}

function buildContext(meta, actorId) {
  // 优先:per-terminal 真抓包请求体(wb-claude 进程内代理覆盖式落盘),用真请求体切块展示。
  // 后锚 = turn-first.json(本轮首轮,回退 last-request.json);前锚 = prev-request.json(上一轮末态)。
  const capFile = captureFilePath(actorId);   // .../last-request.json
  if (capFile) {
    const dir = path.dirname(capFile);
    const turnFirstFile = path.join(dir, 'turn-first.json');
    const prevReqFile = path.join(dir, 'prev-request.json');
    const bodyFile = fs.existsSync(turnFirstFile) ? turnFirstFile : capFile;
    if (fs.existsSync(bodyFile)) {
      try {
        const body = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
        if (body && (Array.isArray(body.system) || Array.isArray(body.messages))) {
          let cap = {};
          try { cap = JSON.parse(fs.readFileSync(bodyFile.replace(/\.json$/, '.meta.json'), 'utf8')); } catch { /* meta 缺失不致命 */ }
          let prevBody = null;
          try {
            if (fs.existsSync(prevReqFile)) {
              const pb = JSON.parse(fs.readFileSync(prevReqFile, 'utf8'));
              if (pb && (Array.isArray(pb.system) || Array.isArray(pb.messages))) prevBody = pb;
            }
          } catch { /* prev 损坏 → 退回无 prev 的 approx */ }
          return buildFromCapture(body, meta, cap, prevBody);
        }
      } catch { /* 抓包文件损坏 → 落回 jsonl 重建 */ }
    }
  }

  const sessionId = meta.sessionId;
  if (!sessionId) return { available: false, reason: '该终端尚未运行或非 CC 类型（无 sessionId）' };
  const file = locateSessionFile(meta.projectPath, sessionId);
  if (!file) return { available: false, reason: '未找到该会话的上下文记录文件（jsonl）' };

  const { rows, truncated } = readSessionRows(file);

  // 最后一条带 usage 的记录 → 当前上下文真实占用（headline 用真数，非估算）；首条用于首次 loop 命中率
  let lastUsage = null, firstUsage = null;
  for (const o of rows) {
    const m = o.message;
    if (m && typeof m === 'object' && m.usage) { if (!firstUsage) firstUsage = m.usage; lastUsage = m.usage; }
  }
  const realCtxTokens = lastUsage
    ? (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0)
    : 0;

  // 预扫：标记 memex 召回的 Read（tool_use_id → 模块文件路径），其结果块单独成区
  const memexIds = new Map();
  for (const o of rows) {
    const m = o.message;
    const cont = m && typeof m === 'object' ? m.content : null;
    if (!Array.isArray(cont)) continue;
    for (const b of cont) {
      if (b && b.type === 'tool_use' && b.name === 'Read') {
        const fp = (b.input || {}).file_path || '';
        if (MEMEX_PATH_RE.test(fp)) memexIds.set(b.id, fp);
      }
    }
  }

  const { sections, cats } = rowsToSections(rows, memexIds);

  // 合成占位块塞到最前(真实 wire 请求里它们排在所有 message 之前):tools+system → gitStatus。
  // 同一对象引用也塞进 prevSections,让缓存 diff 逐块对齐时它们落在前缀(body 自等 → cached)。
  // gitStatus 仅当 jsonl 里没有已识别出的 gitStatus 块时才合成(避免老版本 CC 落盘时重复)。
  const sysSection = buildSystemSection();
  const synthHead = [];
  const hasGitInJsonl = sections.some(s => s.title === '⚙️ gitStatus / 环境');
  const gitSection = hasGitInJsonl ? null : buildGitStatusSection(meta);
  if (gitSection) { sections.unshift(gitSection); synthHead.unshift(gitSection); cats['注入·gitStatus/环境'] = (cats['注入·gitStatus/环境'] || 0) + gitSection.tok; }
  sections.unshift(sysSection); synthHead.unshift(sysSection);
  cats['系统·tools+system'] = (cats['系统·tools+system'] || 0) + sysSection.tok;

  // —— 每块缓存命中诊断 ——
  // 缓存命中 = 连续前缀；断点 = 本轮请求相对上轮请求第一处不同的块。
  // jsonl append-only，每个 assistant turn = 一次 API 请求，其输入 = 它之前的所有 rows。
  // 最新 usage 的 cache_read 反映的是「上一轮请求的输入」被命中的前缀，
  // 故上轮请求输入 = rows 截断到「倒数第二个 assistant message 之前」。
  const asstIdxs = [];
  rows.forEach((o, i) => {
    if (o.type === 'assistant' && o.message && typeof o.message === 'object') asstIdxs.push(i);
  });
  let prevSections = null;
  if (asstIdxs.length >= 2) {
    const prevRows = rows.slice(0, asstIdxs[asstIdxs.length - 2]);   // 倒数第二个 assistant 之前
    prevSections = rowsToSections(prevRows, memexIds).sections;
    prevSections.unshift(...synthHead);   // 与 sections 对齐:同引用前缀 → body 自等 → 标 cached
  }
  // cacheState 判定统一上浮前端(与 capture 路径同架构):后端只透传 prevSigs(prev 同构切块签名),
  // 前端做前缀 diff。asstIdxs<2 → 无上轮 → prevSigs=null → 前端退 approx 兜底。
  const prevSigs = prevSections ? prevSections.map(sectionSig) : null;

  const total = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
  const breakdown = Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, tok]) => ({ cat, tok, pct: Math.round(tok / total * 100) }));

  return {
    available: true,
    source: 'reconstruct',
    realCtxTokens,
    usageDetail: lastUsage ? {
      input: lastUsage.input_tokens || 0,
      cache_read: lastUsage.cache_read_input_tokens || 0,
      cache_creation: lastUsage.cache_creation_input_tokens || 0,
    } : null,
    firstUsageDetail: (firstUsage && firstUsage !== lastUsage) ? {
      input: firstUsage.input_tokens || 0,
      cache_read: firstUsage.cache_read_input_tokens || 0,
      cache_creation: firstUsage.cache_creation_input_tokens || 0,
    } : null,
    breakdown,
    sections,
    prevSigs,
    truncated,
    sessionId,
  };
}

export function handleActorsApi(req, res, bus, poolSupervisor, broadcaster) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // GET /api/providers
  if (req.method === 'GET' && p === '/api/providers') {
    json(res, 200, getProviders());
    return true;
  }

  // POST /api/messages
  if (req.method === 'POST' && p === '/api/messages') {
    parseBody(req).then(({ to_id, kind, payload }) => {
      if (!to_id || !kind) { json(res, 400, { error: 'to_id and kind required' }); return; }
      // 作用域访客只能发给自己那个 actor（body 里的 to_id 由 auth 收窄，这里强制）
      if (req.scopedActor && to_id !== req.scopedActor) {
        json(res, 403, { error: 'forbidden: outside share scope' });
        return;
      }
      const msg = bus.insertMessage({
        from_id: 'human_self',
        to_id,
        kind,
        payload: payload ?? {},
        ts: Date.now(),
      });
      json(res, 201, { id: msg.id });
    }).catch(() => json(res, 400, { error: 'invalid JSON' }));
    return true;
  }

  // GET /api/actors
  if (req.method === 'GET' && p === '/api/actors') {
    // 作用域访客：只返回它那一个 actor（后端裁剪，前端拿不到全站清单）
    if (req.scopedActor) {
      const row = bus.db.prepare("SELECT * FROM actors WHERE id=? AND status!='gone'").get(req.scopedActor);
      json(res, 200, row ? [{ ...row, meta: JSON.parse(row.meta || '{}') }] : []);
      return true;
    }
    const rows = bus.db.prepare("SELECT * FROM actors WHERE status!='gone' ORDER BY created_at ASC").all();
    json(res, 200, rows.map(r => ({ ...r, meta: JSON.parse(r.meta || '{}') })));
    return true;
  }

  // POST /api/actors
  if (req.method === 'POST' && p === '/api/actors') {
    parseBody(req).then((body) => {
      const { kind = 'cc', meta = {}, workDir } = body;
      const creator = ACTOR_CREATORS[kind];
      if (!creator) {
        const allowed = Object.keys(ACTOR_CREATORS).join(', ');
        json(res, 400, { error: `kind=${kind} not supported (allowed: ${allowed})` });
        return;
      }
      // ── wire 形状护栏（需完整 body，只能在 handler 层判；把历史"静默容错"坑变成响亮 400）──
      // B. 本该嵌在 meta 下的字段错放到了顶层（先判：即便同时 meta 空，这条诊断更精确）。
      //    workDir 不在黑名单——它是历史文档格式，下面映射进 meta 而非拒绝。
      const META_KEYS = ['task', 'model', 'type', 'callbackActorId', 'geneExclude', 'geneAppend', 'role', 'prompt', 'advisorType', 'driver'];
      const misplaced = META_KEYS.filter(k => k in body);
      if (misplaced.length) {
        json(res, 400, { error: `以下字段必须嵌在 meta 下，不能放顶层: ${JSON.stringify(misplaced)}` });
        return;
      }
      // A. 空壳 meta（kind=cc）：curl 截断 / jq 失败致空 body / 字段全错放 meta 外 → 造无用僵尸终端。
      if (kind === 'cc' && (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0)) {
        json(res, 400, { error: '拒绝创建空壳终端：meta 为空。检查 JSON body 是否被截断 / jq 是否失败 / 字段是否错放在 meta 外' });
        return;
      }
      // 顶层 workDir → meta.projectPath：handler 只解构 kind+meta，顶层 workDir 本会被静默丢弃，
      // 致文档 spawn 格式的 cwd 失效（cwd 由 meta.projectPath 决定，见 process.mjs:104）。这里映射让其真正生效；显式 meta.projectPath 优先。
      const finalMeta = (workDir && !meta.projectPath) ? { ...meta, projectPath: workDir } : meta;
      const r = creator({ meta: finalMeta, bus, poolSupervisor, broadcaster });
      if (!r.ok) { json(res, r.code || 400, { error: r.error }); return; }
      json(res, 201, { actorId: r.actorId });
    }).catch(() => json(res, 400, { error: 'invalid JSON' }));
    return true;
  }

  // /api/actors/:id/...
  if (p.startsWith('/api/actors/')) {
    const rest = p.slice('/api/actors/'.length);       // "id" or "id/messages" etc.
    const slashIdx = rest.indexOf('/');
    const actorId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const sub = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);

    if (!actorId) { json(res, 400, { error: 'missing actorId' }); return true; }

    // GET /api/actors/:id/messages —— 三种模式（默认只给最近一页，避免拉全量 MB 级历史）
    //   ?since=<id>          增量：拿 id 之后的全部（追平本地缓存），升序——用于二次进入只补差量
    //   ?before=<id>&limit=  上滑加载更早：取 id<before 的最近 limit 条
    //   (无参数)&limit=      首屏：最近 limit 条（默认 200，上限 1000）
    // 三种都返回升序，前端直接 append/prepend。
    if (req.method === 'GET' && sub === 'messages') {
      const sp = url.searchParams;
      const limit = Math.min(Math.max(Number(sp.get('limit')) || 200, 1), 1000);
      let rows;
      if (sp.get('since')) {
        const since = Number(sp.get('since')) || 0;
        rows = bus.db.prepare(
          'SELECT * FROM messages WHERE (to_id=? OR from_id=?) AND id>? ORDER BY id ASC'
        ).all(actorId, actorId, since);
      } else if (sp.get('before')) {
        const before = Number(sp.get('before')) || 0;
        rows = bus.db.prepare(
          'SELECT * FROM messages WHERE (to_id=? OR from_id=?) AND id<? ORDER BY id DESC LIMIT ?'
        ).all(actorId, actorId, before, limit).reverse();
      } else {
        rows = bus.db.prepare(
          'SELECT * FROM messages WHERE (to_id=? OR from_id=?) ORDER BY id DESC LIMIT ?'
        ).all(actorId, actorId, limit).reverse();
      }
      json(res, 200, rows.map(m => ({ ...m, payload: JSON.parse(m.payload) })));
      return true;
    }

    // GET /api/actors/:id/context —— 只读上下文检视器：摊开该终端当前上下文窗口里装了什么
    //   纯读 ~/.claude/projects/<encWorkDir>/<sessionId>.jsonl，零写入、不碰 bus.db
    if (req.method === 'GET' && sub === 'context') {
      const row = bus.db.prepare('SELECT kind, meta FROM actors WHERE id=?').get(actorId);
      if (!row) { json(res, 404, { error: 'not found' }); return true; }
      let meta;
      try { meta = JSON.parse(row.meta || '{}'); } catch { meta = {}; }
      try {
        json(res, 200, row.kind === 'ling' ? buildLingContext(meta) : buildContext(meta, actorId));
      } catch (e) {
        json(res, 500, { available: false, reason: `解析失败: ${e.message}` });
      }
      return true;
    }

    // GET /api/actors/:id
    if (req.method === 'GET' && sub === '') {
      const row = bus.db.prepare('SELECT * FROM actors WHERE id=?').get(actorId);
      if (!row) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, { ...row, meta: JSON.parse(row.meta || '{}') });
      return true;
    }

    // DELETE /api/actors/:id
    if (req.method === 'DELETE' && sub === '') {
      poolSupervisor.stopActor(actorId);
      bus.db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?").run(Date.now(), actorId);
      broadcaster?.broadcastActorGone(actorId);
      // bus 事件：让 policy 层（如 orphan-worker）反应式订阅；'gone' 是头等公民事件
      bus.emit('actor_status', { actorId, status: 'gone' });
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/actors/:id/interrupt — 打断当前 turn（不杀 actor）
    // 走 kind='control' 消息，cc-pool 的 controls.mjs 收到 command='interrupt' 后
    // 给子进程 stdin 写 CC 原生 control_request interrupt 帧，actor 保持 idle 可继续接消息
    if (req.method === 'POST' && sub === 'interrupt') {
      const exists = bus.db.prepare("SELECT id FROM actors WHERE id=? AND status!='gone'").get(actorId);
      if (!exists) { json(res, 404, { error: 'actor not found or gone' }); return true; }
      bus.insertMessage({
        from_id: 'human_self', to_id: actorId, kind: 'control',
        payload: { command: 'interrupt' }, ts: Date.now(),
      });
      json(res, 200, { ok: true });
      return true;
    }

    // PATCH /api/actors/:id/advisor-type
    if (req.method === 'PATCH' && sub === 'advisor-type') {
      parseBody(req).then(({ advisorType }) => {
        const actor = patchMeta(bus, actorId, { advisorType });
        if (!actor) { json(res, 404, { error: 'not found' }); return; }
        broadcaster?.broadcastActorUpdate(actor);
        json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { error: 'invalid JSON' }));
      return true;
    }

    // PATCH /api/actors/:id/lock
    if (req.method === 'PATCH' && sub === 'lock') {
      parseBody(req).then(({ locked }) => {
        const actor = patchMeta(bus, actorId, { locked });
        if (!actor) { json(res, 404, { error: 'not found' }); return; }
        broadcaster?.broadcastActorUpdate(actor);
        json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { error: 'invalid JSON' }));
      return true;
    }

    // PATCH /api/actors/:id/name
    if (req.method === 'PATCH' && sub === 'name') {
      parseBody(req).then(({ name }) => {
        const actor = patchMeta(bus, actorId, { name });
        if (!actor) { json(res, 404, { error: 'not found' }); return; }
        broadcaster?.broadcastActorUpdate(actor);
        json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { error: 'invalid JSON' }));
      return true;
    }

    // PATCH /api/actors/:id/meta
    if (req.method === 'PATCH' && sub === 'meta') {
      parseBody(req).then((updates) => {
        const actor = patchMeta(bus, actorId, updates);
        if (!actor) { json(res, 404, { error: 'not found' }); return; }
        broadcaster?.broadcastActorUpdate(actor);
        json(res, 200, { ok: true });
      }).catch(() => json(res, 400, { error: 'invalid JSON' }));
      return true;
    }
  }

  return false;
}
