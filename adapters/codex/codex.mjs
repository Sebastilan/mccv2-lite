// codex.mjs — Codex 终端 adapter（actor-stdio v1；每轮起一次 `codex exec --json`，续轮 `resume <thread>`）
//
// 为什么不用常驻 app-server：按轮起进程，空闲时只剩这个几十 MB 的 node，内存最省；
// 代价是每轮多一次 codex 冷启动（约 1–2 秒）。会话由 Codex 自己存在 ~/.codex，thread_id 记进 actor.meta.sessionId，
// 重启服务后接着聊。登录态沿用本机 `codex login`，不拷、不读 token。
//
// 环境变量（都可选）：
//   MCC_CODEX_BIN    codex 可执行文件，默认 PATH 里的 codex
//   MCC_CODEX_ARGS   额外参数（空格分隔，原样塞进 codex exec，例：-c model_provider="openai"）
//   MCC_CODEX_SANDBOX  read-only | workspace-write(默认) | danger-full-access
//   CODEX_MOCK=1     离线 stub，不起 codex（自检用）
//
// 审阅约定：codex 没有 append-system-prompt，所以首轮把 REVIEW_RULE 拼在用户那句话前，
// 之后收到「### 对 xxx 的批注」时在话前补一行提醒（FEEDBACK_REMINDER）。

import readline from 'readline';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { REVIEW_RULE, FEEDBACK_REMINDER } from '../../src/pools/_base/review-rule.mjs';

const V = 1;
const MOCK = process.env.CODEX_MOCK === '1';
const BIN = process.env.MCC_CODEX_BIN || 'codex';
const SANDBOX = process.env.MCC_CODEX_SANDBOX || 'workspace-write';
const WORKSPACE = process.env.MCC_WORKSPACE || path.join(homedir(), 'mcc-workspace');

let actorId = null;
let meta = {};
let threadId = null;
let child = null;
let interrupting = false;

function emit(ev, fields) { process.stdout.write(JSON.stringify({ v: V, ev, ...fields }) + '\n'); }
function log(msg) { process.stderr.write(`[codex:${actorId || '?'}] ${msg}\n`); }

/** MCC_CODEX_ARGS 按空格拆；双引号内的空格保留（不做转义） */
export function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) {
    // 形如 key="v w" 的整体保留：先按空白切，再把引号配平
    out.push(m[0]);
  }
  return out.map(x => x.replace(/^"(.*)"$/, '$1'));
}

/** 组装本轮发给 codex 的提示：首轮带审阅约定，批注轮带提醒 */
export function buildPrompt(text, first) {
  const t = text || '';
  if (first) return `${REVIEW_RULE}\n\n用户的话：\n${t}`;
  if (/^###\s*对.+的批注/m.test(t)) return `${FEEDBACK_REMINDER}\n${t}`;
  return t;
}

/** codex exec 的命令行（新会话 / resume 两种）。sandbox 经 -c 设，因为 resume 不收 -s。 */
export function buildArgs({ prompt, threadId, model, cwd }) {
  const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${SANDBOX}"`, ...splitArgs(process.env.MCC_CODEX_ARGS)];
  if (model) common.push('-m', model);
  const args = ['exec'];
  if (threadId) args.push('resume', threadId, ...common, '--', prompt);
  else args.push(...common, '-C', cwd, '--', prompt);   // -- 之后全是提示:以 - 开头的话不会被当参数
  return args;
}

/** 把 codex 的一行 JSON 事件翻成 stdio v1 事件；返回需要累计的信息。纯函数，便于单测。 */
export function translate(ev, state) {
  switch (ev.type) {
    case 'thread.started':
      state.threadId = ev.thread_id;
      return [];
    case 'item.completed': {
      const it = ev.item || {};
      if (it.type === 'agent_message' && (it.text || '').trim()) return [{ ev: 'text', text: it.text }];
      if (it.type === 'command_execution') {
        state.tools.shell = (state.tools.shell || 0) + 1;
        return [{ ev: 'tool_call', id: it.id, name: 'shell', input: { command: unwrapShell(it.command) },
          result_summary: `rc=${it.exit_code} ${String(it.aggregated_output || '').slice(0, 800)}` }];
      }
      if (it.type === 'file_change') {
        state.tools.apply_patch = (state.tools.apply_patch || 0) + 1;
        const files = (it.changes || []).map(c => `${c.kind || ''} ${c.path || ''}`.trim()).join(', ');
        return [{ ev: 'tool_call', id: it.id, name: 'apply_patch', input: { files }, result_summary: files }];
      }
      if (it.type === 'reasoning' && it.text) return [{ ev: 'reasoning', subtype: 'thinking', text: it.text }];
      return [];
    }
    case 'turn.completed':
      state.usage = ev.usage || {};
      return [];
    case 'turn.failed':
    case 'error': {
      const msg = ev.error?.message || ev.message || 'codex 报错';
      if (!state.errors.includes(msg)) state.errors.push(msg);
      return [];
    }
    default: return [];
  }
}

// codex 把命令包成 /bin/bash -lc '…'，面板只画里面那条
function unwrapShell(c) {
  const m = String(c || '').match(/^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/);
  return m ? m[2] : c;
}

function handleStart(cmd) {
  actorId = cmd.actor_id;
  meta = cmd.meta || {};
  threadId = meta.sessionId || null;
  log(`started thread=${threadId || '(new)'} mode=${MOCK ? 'mock' : 'real'}`);
  emit('session_init', { ...(threadId ? { session_id: threadId } : {}), model: meta.model || 'codex', capabilities: ['chat', 'shell', 'apply_patch'] });
}

function handleStop() {
  killChild();
  process.exit(0);
}

function killChild() {
  if (!child) return;
  interrupting = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已退 */ } }
}

function handleControl(cmd) {
  if (cmd.kind === 'interrupt') { log('interrupt'); killChild(); }
  if (cmd.kind === 'model' && cmd.model !== undefined) { meta.model = cmd.model; log(`model -> ${cmd.model || '(default)'}`); }
}

async function handleDeliver(cmd) {
  const { msg_id, text } = cmd;
  const atts = Array.isArray(cmd.attachments) ? cmd.attachments : [];
  const words = (text || '') + (atts.length ? '\n\n附件路径：\n' + atts.map(a => a.path).filter(Boolean).join('\n') : '');
  if (MOCK) return runMock(msg_id, words);
  return runCodex(msg_id, words);
}

function runMock(msg_id, words) {
  const first = !threadId;
  if (first) { threadId = `mock-${Date.now()}`; emit('session_init', { session_id: threadId, model: 'codex', capabilities: ['chat'] }); }
  // SHARE_TEST:<路径> → 回复里带 [SHARE:路径]，自检靠它验「审阅卡」链路
  const sh = /SHARE_TEST:(\S+)/.exec(words);
  emit('text', { text: `（mock codex）收到：${buildPrompt(words, first).slice(-60)}${sh ? `\n[SHARE:${sh[1]}]` : ''}` });
  emit('tool_call', { id: 'mock1', name: 'shell', input: { command: 'echo mock' }, result_summary: 'rc=0 mock' });
  emit('turn_done', { msg_id, cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, tools: { shell: 1 }, stop_reason: 'end_turn', interrupted: false });
}

function runCodex(msg_id, words) {
  return new Promise((resolve) => {
    const cwd = meta.projectPath || WORKSPACE;
    try { mkdirSync(cwd, { recursive: true }); } catch { /* 已存在 */ }
    const first = !threadId;
    const args = buildArgs({ prompt: buildPrompt(words, first), threadId, model: meta.model, cwd });
    const state = { threadId: null, tools: {}, usage: {}, errors: [] };
    interrupting = false;
    let spawnError = null;
    child = spawn(BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env });
    child.on('error', (e) => { spawnError = e; });
    child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) log(`stderr ${s.slice(0, 200)}`); });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.startsWith('{')) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const wasNew = !threadId && !state.threadId;
      for (const out of translate(ev, state)) {
        const { ev: name, ...rest } = out;
        emit(name, rest);
      }
      if (wasNew && state.threadId) {
        threadId = state.threadId;
        emit('session_init', { session_id: threadId, model: meta.model || 'codex', capabilities: ['chat', 'shell', 'apply_patch'] });
      }
    });
    child.on('close', (code, signal) => {
      child = null;
      let reason = 'end_turn';
      if (interrupting) reason = 'interrupted';
      else if (spawnError) {
        reason = 'error';
        emit('text', { text: spawnError.code === 'ENOENT'
          ? `（找不到 codex 命令：请先安装 \`npm i -g @openai/codex\` 并执行 \`codex login\`；或用 MCC_CODEX_BIN 指定路径）`
          : `（codex 启动失败：${spawnError.message}）` });
      } else if (state.errors.length || code !== 0) {
        reason = 'error';
        emit('text', { text: `（codex 出错：${state.errors.join('；') || `退出码 ${code ?? signal}`}。检查是否已 \`codex login\`、网络是否可用）` });
      }
      const u = state.usage;
      emit('turn_done', {
        msg_id, cost_usd: 0,
        usage: { input_tokens: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: u.cached_input_tokens || 0 },
        tools: state.tools, stop_reason: reason, interrupted: interrupting,
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
        case 'stop': handleStop(); break;
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
  rl.on('close', () => { killChild(); process.exit(0); });
  process.on('SIGTERM', () => { killChild(); process.exit(0); });
  process.on('SIGINT', () => { killChild(); process.exit(0); });
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) startLoop();
