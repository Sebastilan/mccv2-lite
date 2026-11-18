// chat.mjs — 「慢聊」adapter（actor-stdio v1，自包含：DeepSeek/Anthropic 兼容端点 + 文件工具）
//
// 「最小 agent」：
//   - 纯 API 直连（Anthropic 兼容端点：DeepSeek 或任意网关）
//   - 四个工具：read/write/edit_file + now
//   - 会话历史落 data/chat-sessions/<sessionId>.jsonl，给跨 pool 重启的连续性
//
// CHAT_MOCK=1：极简离线 stub（不发 API），给 base-pool 集成测试用。
//
// 工具实现（writeFileTool 等）作为命名导出，供单测直接调用——
// 仅当本文件作为入口运行时才启动 stdio v1 主循环（见文件末尾 isEntry 判别）。

import readline from 'readline';
import path from 'path';
import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const V = 1;
const MOCK = process.env.CHAT_MOCK === '1';

// ── Provider：非 deepseek-* 模型发给任意 Anthropic 兼容网关（/v1/messages），地址与 key 自备 ──
const PROVIDER = {
  url: process.env.PROVIDER_CHAT_URL || 'https://api.anthropic.com/v1/messages',
  key: process.env.PROVIDER_CHAT_KEY || process.env.ANTHROPIC_API_KEY || '',
  defaultModel: 'deepseek-v4-flash',
};

// DeepSeek 官方的 Anthropic 兼容端点。tools / content block / 多轮历史全都原样走得通,
// 所以本 adapter 不需要任何格式翻译层 —— 只是换个 url + key。
// 慢聊的默认档就是它:v4-flash 关掉思考后中位 1.4s,opus 4.0s(2026-08-11 实测,
// 6 次交错采样取中位数;样本少于 5 次时网络抖动会盖过真实差异,别拿 3 次的结果下结论)。
// 代价是判断力明显下降,所以是**慢聊这一档的默认**,不是全平台换——满血思考的活交给 CC。
const DEEPSEEK = {
  url: process.env.PROVIDER_DEEPSEEK_URL || 'https://api.deepseek.com/anthropic/v1/messages',
  key: process.env.DEEPSEEK_API_KEY || process.env.PROVIDER_DEEPSEEK_KEY || '',
};

/** 按模型名选后端。deepseek-* 走 DeepSeek，其余走 PROVIDER_CHAT_URL。 */
function providerFor(model) {
  if (String(model || '').startsWith('deepseek')) {
    if (!DEEPSEEK.key) throw new Error('DEEPSEEK_API_KEY 未设置，无法使用 deepseek 模型');
    return DEEPSEEK;
  }
  return PROVIDER;
}

// 会话历史落盘目录（CHAT_SESS_DIR 覆盖，给测试隔离用）
const SESS_DIR = process.env.CHAT_SESS_DIR || path.join(ROOT, 'data', 'chat-sessions');

// 慢聊笔记的默认落点（CHAT_NOTE_DIR 覆盖）
const NOTE_DIR = process.env.CHAT_NOTE_DIR || path.join(ROOT, 'data', 'chat-notes');

const PERSONA = '你是「慢聊」，一个轻量的随手助手。可以随便聊聊、顺手把内容写到本地文件、'
  + '或者读一下本地文档。回答简洁、口语化。需要写文件时用 write_file 工具，'
  + '需要读文件时用 read_file 工具。'
  + '需要局部编辑文件时用 edit_file 工具（old_string→new_string 精确替换，本轮已读过或刚写过的文件直接 edit 不需要先 read）。'
  + `\n写聊天笔记/纪要/随手记时，除非用户明确指定别处，一律写到 ${NOTE_DIR}/ 下（用绝对路径，文件名用中文短标题.md）。不要写到代码仓目录里。`;

// 附件内联上限(解码后字节)。图片/文本类附件转成 Anthropic content block 塞进 user 消息;
// 超限的只留占位说明,不把大 buffer 塞进历史。照 src/pools/cc/stdin.mjs 同款三分逻辑。
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const TEXT_EXT = new Set(['md','markdown','txt','log','json','jsonl','yaml','yml','toml','ini','csv','tsv','xml','html','htm','css','js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','c','h','cpp','hpp','cs','sh','bash','zsh','fish','sql','env','conf']);
function isTextLike(mime, name) {
  if (mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/x-yaml' || mime.includes('javascript') || mime.includes('xml'))) return true;
  const ext = (name || '').split('.').pop()?.toLowerCase();
  return ext && TEXT_EXT.has(ext);
}

// text + attachments → Anthropic user content。纯文本无附件时返回 string(保持旧格式,历史更紧凑);
// 有附件时返回 block 数组(text + image/文本内联/占位)。
export function buildUserContent(text, attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return text || '';
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const att of list) {
    const mime = att.mimeType || att.mime || '';
    const raw = String(att.data || '');
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    const tooBig = base64.length * 0.75 > MAX_INLINE_BYTES;
    if (mime.startsWith('image/') && base64 && !tooBig) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } });
    } else if (base64 && isTextLike(mime, att.name) && !tooBig) {
      let content = '';
      try { content = Buffer.from(base64, 'base64').toString('utf8'); } catch { content = ''; }
      blocks.push({ type: 'text', text: `\n[附件: ${att.name || 'file'}]\n\`\`\`\n${content}\n\`\`\`` });
    } else if (att.name) {
      blocks.push({ type: 'text', text: `\n[附件: ${att.name}]（${tooBig ? '超过 8MB 未内联' : '二进制未内联'}）` });
    }
  }
  if (!blocks.length) return text || '';
  return blocks;
}

// ── 工具 schema（Anthropic 原生 tools 格式）────────────────────────────────
const TOOLS = [
  {
    name: 'write_file',
    description: '把内容写入本地文件（覆盖式）。相对路径基于当前工作目录，也支持绝对路径。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对或绝对）' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: '读取本地文件内容并返回。相对路径基于当前工作目录，也支持绝对路径。适合读代码、文档、配置文件等。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对或绝对）' },
        max_chars: { type: 'number', description: '最多返回多少字符，默认 20000，超长文件建议分段读' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: '对本地文件做精确字符串替换。把 old_string 替换成 new_string，old_string 必须在文件中唯一存在。本轮已读过或刚写过的文件直接调用，不需要先 read_file。',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: '文件路径（相对或绝对）' },
        old_string: { type: 'string', description: '要替换掉的原始字符串（必须在文件中唯一）' },
        new_string: { type: 'string', description: '替换后的新字符串' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  // now：模型没有时钟，问「现在几点」时必须用它。只读、零副作用。
  {
    name: 'now',
    description: '取当前日期时间（服务器本地时区）。问到"现在几点""今天几号""星期几"必须用它，不要凭感觉答。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

let actorId = null;
let meta = {};
let sessionId = null;
let history = [];        // 进程内会话历史（Anthropic messages 数组）
let persistedCount = 0;  // 已落盘的 history 条数（增量 append）
let aborted = false;

function emit(ev, fields) {
  process.stdout.write(JSON.stringify({ v: V, ev, ...fields }) + '\n');
}
function log(msg) {
  process.stderr.write(`[chat:${actorId || '?'}] ${msg}\n`);
}

// ── 工具一：read_file ─────────────────────────────────────────────────────
export function readFileTool({ path: p, max_chars = 20000 }, { cwd = process.cwd() } = {}) {
  const target = String(p || '');
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  try {
    const raw = readFileSync(abs, 'utf8');
    const trimmed = raw.length > max_chars ? raw.slice(0, max_chars) + `\n…（已截断，共 ${raw.length} 字符）` : raw;
    return { ok: true, path: abs, chars: raw.length, content: trimmed };
  } catch (e) {
    return { ok: false, path: abs, error: e.message };
  }
}

// ── 工具二：edit_file（精确字符串替换，本轮已知文件内容直接改，不必先 read）────
export function editFileTool({ path: p, old_string, new_string }, { cwd = process.cwd() } = {}) {
  const target = String(p || '');
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  try {
    const raw = readFileSync(abs, 'utf8');
    const count = raw.split(old_string).length - 1;
    if (count === 0) return { ok: false, path: abs, error: 'old_string 在文件中未找到' };
    if (count > 1)   return { ok: false, path: abs, error: `old_string 在文件中出现 ${count} 次，必须唯一` };
    const updated = raw.replace(old_string, new_string);
    writeFileSync(abs, updated, 'utf8');
    return { ok: true, path: abs, bytes: Buffer.byteLength(updated) };
  } catch (e) {
    return { ok: false, path: abs, error: e.message };
  }
}

// ── 工具三：write_file（治幻觉——返回写盘事实证据）─────────────────────────
export function writeFileTool({ path: p, content }, { cwd = process.cwd() } = {}) {
  const target = String(p || '');
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  if (path.isAbsolute(target)) log(`write_file 绝对路径: ${abs}`);
  mkdirSync(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(content == null ? '' : String(content), 'utf8');
  writeFileSync(abs, buf);
  return { ok: true, path: abs, bytes: buf.length };
}

// ── 工具三:now(当前时间)────────────────────────────────────────────────────
// 模型没有时钟。不给这个工具,问"现在几点"它只能瞎猜或道歉 —— 语音场景实测过,
// 很露怯。星期几一并给出:中文里"这周五"之类的换算全靠它。
export function nowTool() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const week = '日一二三四五六'[d.getDay()];
  return {
    ok: true,
    iso: d.toISOString(),
    text: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} `
        + `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

// ── 历史合法化(非破坏,防 400)──────────────────────────────────────────────────
// 原则:聊天记录是事实层,一字不删。这里只把「发给 Anthropic 的临时副本」整成合法形状,
// 绝不删原始对话内容、绝不回写落盘。修两类会 400 的结构:
//   1) 悬空 tool_use —— assistant 的 tool_use 后面没有紧跟同 id 的 tool_result
//      (令牌吊销/max_tokens 截断时最易发生)→ 在其后【补一条合成 tool_result】收口,
//      保留 tool_use 语境、也诚实标注「该轮工具未完成」,而非删掉它。
//   2) 连续同角色消息 —— 多次失败重试攒下的连续 user → 合并(内容拼接,不丢文本)。
// 纯函数、不改入参。仅 callApi 发送前跑;loadHistory 只读取、不清洗、不回写。
const SYNTH_TOOL_RESULT = '⚠️ 该轮工具调用因连接中断未返回结果（对话已恢复，可继续）。';
function cloneContent(c) { return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(b => ({ ...b })) : c); }
function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a + '\n' + b;
  const arr = x => typeof x === 'string' ? [{ type: 'text', text: x }] : (Array.isArray(x) ? x : [x]);
  return [...arr(a), ...arr(b)];
}
export function sanitizeMessages(rows) {
  // 第一遍:给悬空 tool_use 补合成 tool_result(非破坏,不删任何原始内容)
  const paired = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    paired.push(m);
    const content = m && m.content;
    if (m.role === 'assistant' && Array.isArray(content)) {
      const next = rows[i + 1];
      const answered = new Set();
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const b of next.content) if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
      }
      const unanswered = content.filter(b => b.type === 'tool_use' && !answered.has(b.id));
      if (unanswered.length) {
        paired.push({ role: 'user', content: unanswered.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: SYNTH_TOOL_RESULT })) });
      }
    }
  }
  // 第二遍:合并连续同角色,保证 user/assistant 交替(内容拼接,不丢文本)
  const merged = [];
  for (const m of paired) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = mergeContent(last.content, m.content);
    else merged.push({ role: m.role, content: cloneContent(m.content) });
  }
  // 首条必须是 user(Anthropic 要求);仅跳过发送副本的表头,不动原始记录
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

// ── 会话历史持久化（durable，极简）──────────────────────────────────────────
function sessionFile() { return path.join(SESS_DIR, `${sessionId}.jsonl`); }

function loadHistory() {
  try {
    const raw = readFileSync(sessionFile(), 'utf8');
    // 原样读入,忠实还原聊天记录——绝不清洗、绝不回写落盘(合法化只在 callApi 发送副本上做)。
    history = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    persistedCount = history.length;
  } catch { history = []; persistedCount = 0; }
}

// 增量 append 自 persistedCount 起的新消息
function persistHistory() {
  try {
    mkdirSync(SESS_DIR, { recursive: true });
    const fresh = history.slice(persistedCount);
    if (fresh.length) {
      appendFileSync(sessionFile(), fresh.map(m => JSON.stringify(m)).join('\n') + '\n');
      persistedCount = history.length;
    }
  } catch (e) { log(`persistHistory 失败: ${e.message}`); }
}

// ── DeepSeek API 调用(180s timeout,单发不 retry,照 loop.mjs)─────────────────
async function callApi(messages) {
  const model = meta.model || PROVIDER.defaultModel;
  const provider = providerFor(model);
  if (!provider.key) throw new Error('PROVIDER_CHAT_KEY 未设置');
  const body = {
    model,
    max_tokens: 16384,   // 单次额度给足;撞上限由 runRealTurn 的 max_tokens 续写兜底,永不截断丢尾
    system: meta.system || PERSONA,
    messages: sanitizeMessages(messages),   // 发送前兜底清洗：悬空 tool_use / 连续同角色 → 永不 400
    tools: TOOLS,
  };
  // 慢聊永不开思考:DeepSeek 端点不传 thinking 时默认是开的(2026-09-27 curl 实测:
  // 省略 → content 首个 block 就是 thinking;传 disabled → 只有 text)。
  // 多花 ~1s(2.38s → 1.44s)买不来慢聊要的东西——快就够了,深想的问题交给满血 CC。
  if (String(model).startsWith('deepseek')) body.thinking = { type: 'disabled' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const resp = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`API ${resp.status}: ${t.slice(0, 300)}`);
    }
    return await resp.json();
  } finally { clearTimeout(timer); }
}

async function runTool(name, input) {
  const cwd = meta.projectPath || process.cwd();
  if (name === 'read_file')  return readFileTool(input || {}, { cwd });
  if (name === 'edit_file')  return editFileTool(input || {}, { cwd });
  if (name === 'write_file') return writeFileTool(input || {}, { cwd });
  if (name === 'now') return nowTool();
  return { ok: false, error: `未知工具: ${name}` };
}

function summarizeResult(name, result) {
  if (!result) return '';
  if (name === 'read_file')  return result.ok ? `已读取 ${result.path}（${result.chars} 字符）` : `读取失败: ${result.error}`;
  if (name === 'edit_file')  return result.ok ? `已编辑 ${result.path}（${result.bytes} 字节）` : `编辑失败: ${result.error}`;
  if (name === 'write_file') return result.ok ? `已写入 ${result.path}（${result.bytes} 字节）` : `写盘失败`;
  if (name === 'now') return result.text;
  return '';
}

// opus-4.8 cost 估算(API 口径,便于判断量级)：cache_read $1.50/M、uncached $15/M、output $75/M
// 实际走 Max 订阅经 gateway,无边际费用;此处仅作参考成本。
function estimateCost(usage) {
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cached = usage.cache_read_input_tokens || 0;
  return (cached * 1.50 + Math.max(0, inTok - cached) * 15.0 + outTok * 75.0) / 1_000_000;
}

// ── 4 动词处理 ──────────────────────────────────────────────────────────────
function handleStart(cmd) {
  actorId = cmd.actor_id;
  meta = cmd.meta || {};
  sessionId = meta.sessionId || `chat_${actorId}_${Date.now()}`;
  loadHistory();
  log(`started session=${sessionId.slice(0, 24)} mode=${MOCK ? 'mock' : 'real'} history=${history.length}`);
  emit('session_init', {
    session_id: sessionId,
    model: meta.model || PROVIDER.defaultModel,
    capabilities: ['chat', 'read_file', 'edit_file', 'write_file', 'now'],
  });
}

async function handleDeliver(cmd) {
  aborted = false;
  const { msg_id, text, attachments } = cmd;
  if (MOCK) return runMockTurn(msg_id, text);
  return runRealTurn(msg_id, text, attachments);
}

function handleStop() {
  log('stop, exiting cleanly');
  process.exit(0);
}

function handleControl(cmd) {
  if (cmd.kind === 'interrupt') { aborted = true; log('interrupt requested'); return; }
  // 热切模型：下一轮 callApi 直接用新 model（不重启进程、不动会话历史）。
  // 持久化由 pool 侧写 actor.meta 负责，这里只改进程内这份。
  if (cmd.kind === 'model' && cmd.model) { meta.model = cmd.model; log(`model switched -> ${cmd.model}`); }
}

// ── mock:极简,给 base-pool 集成测试用(不发 API)────────────────────────────
async function runMockTurn(msg_id, text) {
  emit('text', { text: `（mock）收到：${(text || '').slice(0, 40)}` });
  emit('tool_call', {
    id: `mock_${Date.now()}`, name: 'write_file',
    input: { path: 'mock.txt', content: 'mock' }, result_summary: 'mock 写盘',
  });
  emit('turn_done', {
    msg_id, cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 },
    tools: { write_file: 1 }, stop_reason: 'end_turn', interrupted: false,
  });
}

// ── real:DeepSeek tool loop(照 loop.mjs 砍到最小)──────────────────────────
async function runRealTurn(msg_id, text, attachments) {
  history.push({ role: 'user', content: buildUserContent(text, attachments) });
  const toolCounts = {};
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let stop_reason = 'end_turn';

  try {
    // 上限放大到 30:既覆盖 tool_use 多轮,也给 max_tokens 自动续写留足步数
    // (16384×30≈49万 token 输出,对聊天等于"想说多长说多长",30 仅为防病态死循环兜底)。
    for (let iter = 0; iter < 30; iter++) {
      if (aborted) { stop_reason = 'interrupted'; break; }
      const data = await callApi(history);
      usage.input_tokens = data.usage?.input_tokens || 0;
      usage.output_tokens += data.usage?.output_tokens || 0;
      usage.cache_read_input_tokens += data.usage?.cache_read_input_tokens || 0;
      stop_reason = data.stop_reason || 'end_turn';

      const content = data.content || [];
      history.push({ role: 'assistant', content });

      const toolResults = [];
      for (const block of content) {
        if (block.type === 'text') {
          emit('text', { text: block.text || '' });
        } else if (block.type === 'tool_use') {
          // 开跑前先吱一声。tool_call 是**跑完**才发的，靠它当"后面还有话"的信号
          // 就等于要等工具跑完 —— 语音网关拿它来决定"能不能把刚才那句应答放出去
          // 填等待"，晚了就白搭（实测搜索类工具跑 2 秒，应答被压后 2 秒才播）。
          emit('reasoning', { subtype: 'tool_start', text: block.name });
          const result = await runTool(block.name, block.input);
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
          // 展示/审阅用 input：文件类工具把相对 path 覆写成 result 里已解析好的绝对路径，
          // 前端工具卡「审阅」链接才拿得到绝对路径（/api/review/share 硬拒相对路径）。
          const shownInput = { ...(block.input || {}) };
          if (['read_file', 'edit_file', 'write_file'].includes(block.name) && result && result.path) {
            shownInput.path = result.path;
          }
          emit('tool_call', {
            id: block.id, name: block.name, input: shownInput,
            result_summary: summarizeResult(block.name, result),
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }

      // 即使被 max_tokens 截断（stop_reason≠'tool_use'）也要把已执行的 tool_result 写回，
      // 收口 tool_use，否则历史里会留悬空 tool_use → 下一轮起永久 400 brick 会话。
      if (toolResults.length) history.push({ role: 'user', content: toolResults });
      // tool_use → 执行完继续;max_tokens → 半截被截,history 末尾已是 assistant 半截内容,
      // 再调一轮模型会接着往下写(前端 text 分片天然拼成一条长消息),直到自己 end_turn。
      // 其余(end_turn/stop_sequence/error)才真正收尾。
      if (stop_reason !== 'tool_use' && stop_reason !== 'max_tokens') break;
    }
  } catch (e) {
    log(`turn error: ${e.stack || e.message}`);
    emit('text', { text: `（内部错误：${e.message}）` });
    stop_reason = 'error';
  }

  persistHistory();
  emit('turn_done', {
    msg_id, cost_usd: estimateCost(usage), usage,
    tools: toolCounts, stop_reason, interrupted: aborted,
  });
}

// ── stdio JSONL 主循环 ──────────────────────────────────────────────────────
function startLoop() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let cmd;
    try { cmd = JSON.parse(line); }
    catch { log(`skip non-JSON: ${line.slice(0, 80)}`); return; }
    if (cmd.v !== V || !cmd.op) return;
    try {
      switch (cmd.op) {
        case 'start':   handleStart(cmd); break;
        case 'deliver': await handleDeliver(cmd); break;
        case 'stop':    handleStop(); break;
        case 'control': handleControl(cmd); break;
        default: log(`unknown op: ${cmd.op}`);
      }
    } catch (e) {
      log(`op ${cmd.op} threw: ${e.stack || e.message}`);
      if (cmd.op === 'deliver') {
        emit('text', { text: `内部错误: ${e.message}` });
        emit('turn_done', { msg_id: cmd.msg_id, stop_reason: 'error', interrupted: false });
      }
    }
  });
  rl.on('close', () => { log('stdin closed'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

// 仅作为入口运行时启动主循环；被单测 import 时不启动（只暴露工具函数）
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) startLoop();
