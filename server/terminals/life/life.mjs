// life.mjs — 傻循环终端 adapter（actor-stdio v1 → Python 傻循环 basic.py）
//
// 傻循环 = 一个很小的 agent 循环：只有一只手 run(shell)，一句话起一个 Python 进程，读会话文件续上文，
// 想、动手、回完即灭（要求本机有 python3 ≥ 3.8）。会话文件在 data/life-sessions/<actorId>.jsonl，
// 所以服务重启、进程被杀都能接着聊。九成窗口自动压缩；Anthropic / OpenAI 两种方言都支持。
//
// 接哪个模型（env 都可选，优先级从上到下）：
//   LIFE_API + LIFE_KEY [+ LIFE_MODEL、LIFE_DIALECT=anthropic|openai、LIFE_EXTRA(JSON)、LIFE_CTX_WINDOW、LIFE_MAX_TOKENS]  任一兼容端点
//   DEEPSEEK_API_KEY       → DeepSeek 官方端点（OpenAI 方言）
//   ANTHROPIC_API_KEY      → Anthropic 官方（模型名 claude-*）；ANTHROPIC_BASE_URL 可指向兼容网关
// 新建终端时弹窗里选的模型（meta.model）优先于 LIFE_MODEL。
// LIFE_PY 指定 python 解释器（默认 python3）；LIFE_MOCK=1 离线 stub（自检用）。

import readline from 'readline';
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { REVIEW_RULE } from '../_base/review-rule.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const V = 1;
const MOCK = process.env.LIFE_MOCK === '1';
const PY = process.env.LIFE_PY || 'python3';
const BASIC = path.join(__dirname, 'basic.py');
const SESS_DIR = process.env.LIFE_SESS_DIR || path.join(ROOT, 'data', 'life-sessions');
const CTX_DIR = process.env.LIFE_CTX_ROOT || path.join(ROOT, 'data', 'life-ctx');
const WORKSPACE = process.env.MCC_WORKSPACE || path.join(homedir(), 'mcc-workspace');
const KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

let actorId = null;
let meta = {};
let child = null;
let interrupting = false;
let lastSum = null;

function emit(ev, fields) { process.stdout.write(JSON.stringify({ v: V, ev, ...fields }) + '\n'); }
function log(msg) { process.stderr.write(`[life:${actorId || '?'}] ${msg}\n`); }

/** 解析接口配置：返回 { env } 或 { error }。纯函数，便于单测。 */
export function resolveConfig(model, env = process.env) {
  if (env.LIFE_API && env.LIFE_KEY) {
    const m = model || env.LIFE_MODEL;
    if (!m) return { error: '已设置 LIFE_API/LIFE_KEY，但没有模型名：新建终端时选一个，或设置 LIFE_MODEL' };
    return { env: { LIFE_API: env.LIFE_API, LIFE_KEY: env.LIFE_KEY, LIFE_MODEL: m,
      LIFE_DIALECT: env.LIFE_DIALECT || 'anthropic', ...(env.LIFE_EXTRA ? { LIFE_EXTRA: env.LIFE_EXTRA } : {}) } };
  }
  if (String(model || '').startsWith('claude') && env.ANTHROPIC_API_KEY) {
    return { env: { LIFE_API: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      LIFE_KEY: env.ANTHROPIC_API_KEY, LIFE_MODEL: model, LIFE_DIALECT: 'anthropic' } };
  }
  if (env.DEEPSEEK_API_KEY && (!model || String(model).startsWith('deepseek'))) {
    return { env: { LIFE_API: env.LIFE_DEEPSEEK_URL || 'https://api.deepseek.com', LIFE_KEY: env.DEEPSEEK_API_KEY,
      LIFE_MODEL: model || 'deepseek-v4-flash', LIFE_DIALECT: 'openai',
      LIFE_EXTRA: env.LIFE_EXTRA || '{"thinking":{"type":"disabled"}}' } };
  }
  return { error: '傻循环没有可用的模型接口。请在 .env 里设置其一：\n'
    + '1) LIFE_API + LIFE_KEY + LIFE_MODEL（可选 LIFE_DIALECT=anthropic|openai）——任一兼容端点；\n'
    + '2) DEEPSEEK_API_KEY；\n3) ANTHROPIC_API_KEY（模型选 claude-*）。设置后重启服务。' };
}

const ctxDir = () => (actorId ? path.join(CTX_DIR, actorId) : null);

function handleStart(cmd) {
  actorId = cmd.actor_id;
  meta = cmd.meta || {};
  log(`started model=${meta.model || '(env)'} mode=${MOCK ? 'mock' : 'real'}`);
  emit('session_init', { session_id: `life_${actorId}`, model: meta.model || process.env.LIFE_MODEL || 'life', capabilities: ['loop', 'run'] });
}

// 打断：SIGTERM 打进程组（detached 起的，-pid 即整组），basic.py 收到后补链、吐一句「[blocked] 被打断」再走
function killLife() {
  if (!child) return;
  interrupting = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已退 */ } }
}

function handleControl(cmd) {
  if (cmd.kind === 'interrupt') { log('interrupt'); killLife(); }
  if (cmd.kind === 'model' && cmd.model) { meta.model = cmd.model; log(`model -> ${cmd.model}`); }
}

function usageDelta(sum) {
  const d = {};
  for (const k of KEYS) d[k] = Math.max(0, (sum[k] || 0) - ((lastSum && lastSum[k]) || 0));
  lastSum = { ...sum };
  return d;
}

function readDump() {
  try { return JSON.parse(readFileSync(path.join(ctxDir(), 'call.json'), 'utf8')); } catch { return null; }
}

function attachNote(atts) {
  if (!atts.length) return '';
  return '\n\n[用户随这句发来 ' + atts.length + ' 个附件，已落盘；图片已直接给你看，其余用命令自己读]\n'
    + atts.map(a => `  ${a.path}${a.media_type ? ` (${a.media_type})` : ''}`).join('\n');
}

async function handleDeliver(cmd) {
  if (typeof cmd.model === 'string' && cmd.model.trim()) meta.model = cmd.model;
  const atts = Array.isArray(cmd.attachments) ? cmd.attachments : [];
  const words = (cmd.text || '') + attachNote(atts);
  if (MOCK) {
    const sh = /SHARE_TEST:(\S+)/.exec(words);   // 回复里带 [SHARE:路径]，自检靠它验「审阅卡」链路
    emit('text', { text: `（mock life）收到：${words.slice(0, 40)}${sh ? `\n[SHARE:${sh[1]}]` : ''}` });
    emit('tool_call', { id: 'mock1', name: 'run', input: { command: 'echo mock' }, result_summary: 'rc=0 mock' });
    emit('turn_done', { msg_id: cmd.msg_id, cost_usd: 0, usage: {}, tools: { run: 1 }, stop_reason: 'end_turn', interrupted: false });
    return;
  }
  return runLife(cmd.msg_id, words, atts);
}

function runLife(msg_id, words, atts) {
  return new Promise((resolve) => {
    const cfg = resolveConfig(meta.model);
    if (cfg.error) {
      emit('text', { text: `（${cfg.error}）` });
      emit('turn_done', { msg_id, cost_usd: 0, usage: {}, tools: {}, stop_reason: 'error', interrupted: false });
      return resolve();
    }
    const cwd = meta.projectPath || WORKSPACE;
    try { mkdirSync(cwd, { recursive: true }); mkdirSync(SESS_DIR, { recursive: true }); mkdirSync(ctxDir(), { recursive: true }); } catch { /* 落不下就没跨句记忆，这一句照跑 */ }
    interrupting = false;
    let verdict = '';
    let steps = 0;
    let spawnError = null;
    child = spawn(PY, [BASIC, cwd, words, 'human'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, ...cfg.env, LIFE_ACTOR: actorId || '', LIFE_SESSION: path.join(SESS_DIR, `${actorId}.jsonl`),
        LIFE_CTX_DUMP: ctxDir(), LIFE_SYSTEM_RULE: REVIEW_RULE, LIFE_SPOOL: path.join(ROOT, 'data', 'life-spool'),
        ...(atts.length ? { LIFE_ATTACH: JSON.stringify(atts) } : {}) },
    });
    child.on('error', (e) => { spawnError = e; });
    child.stdout.on('data', (d) => { verdict += d.toString(); });   // 唯一交付，进程走完再作 text 发出

    const rl = readline.createInterface({ input: child.stderr });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let e = null;
      if (line.startsWith('{')) { try { e = JSON.parse(line); } catch { e = null; } }
      if (e && e.ev === 'think') {
        // 有命令的这一步，模型先说的话（上一步结果、这一步打算）常显；没有命令的就是交付，收工时作 text 发一次
        const text = (e.text || '').trim();
        if (text && (e.calls || []).length) emit('text', { text });
      } else if (e && e.ev === 'obs') {
        steps += 1;
        emit('tool_call', { id: e.id, name: 'run', input: { command: e.cmd }, result_summary: `rc=${e.rc} ${String(e.obs || '').slice(0, 3000)}` });
      } else if (!e) {
        log(`diagnostic: ${line.slice(0, 300)}`);
      }
    });

    child.on('close', (code, signal) => {
      child = null;
      const out = verdict.trim();
      if (spawnError) {
        emit('text', { text: spawnError.code === 'ENOENT'
          ? `（找不到 ${PY}：傻循环需要 python3 ≥ 3.8，请安装，或用 LIFE_PY 指定解释器）`
          : `（傻循环启动失败：${spawnError.message}）` });
      } else if (out) emit('text', { text: out });
      else if (signal) emit('text', { text: `[这一句被 ${signal} 硬杀，没留下交付]` });
      else emit('text', { text: `[傻循环无交付 code=${code}]` });
      const dump = readDump();
      emit('turn_done', {
        msg_id, cost_usd: 0,
        usage: dump?.usage_sum ? usageDelta(dump.usage_sum) : {},
        context_usage: dump?.usage ? { ...dump.usage } : null,
        context_window: dump?.window || undefined,
        tools: steps ? { run: steps } : {},
        stop_reason: (interrupting || signal) ? 'interrupted'
          : (!spawnError && code === 0 && !/^\[(?:接口报错|运行报错)\]/.test(out) ? 'end_turn' : 'error'),
        interrupted: !!(interrupting || signal),
      });
      interrupting = false;
      resolve();
    });
  });
}

function startLoop() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let cmd; try { cmd = JSON.parse(line); } catch { return; }
    if (cmd.v !== V || !cmd.op) return;
    try {
      switch (cmd.op) {
        case 'start': handleStart(cmd); break;
        case 'deliver': await handleDeliver(cmd); break;
        case 'stop': killLife(); process.exit(0); break;
        case 'control': handleControl(cmd); break;
        default: log(`unknown op ${cmd.op}`);
      }
    } catch (e) {
      log(`op ${cmd.op} threw: ${e.stack || e.message}`);
      if (cmd.op === 'deliver') {
        emit('text', { text: `内部错误: ${e.message}` });
        emit('turn_done', { msg_id: cmd.msg_id, stop_reason: 'error', interrupted: false });
      }
    }
  });
  rl.on('close', () => { killLife(); process.exit(0); });
  process.on('SIGTERM', () => { killLife(); process.exit(0); });
  process.on('SIGINT', () => { killLife(); process.exit(0); });
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) startLoop();
