// process.mjs — CC 子进程 spawn + env 净化 + resume（参照 v1 session.mjs + hub process.go）
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { resolveByModel } from '../../providers/_registry.mjs';
import { startCaptureProxy } from './capture-proxy.mjs';

import { REVIEW_RULE } from '../_base/review-rule.mjs';

function findClaude() {
  const candidates = [
    '/usr/local/bin/claude',
    path.join(homedir(), '.local', 'bin', 'claude'),
    path.join(homedir(), '.npm-global', 'bin', 'claude'),   // npm install -g --prefix ~/.npm-global(AGENTS 推荐装法)
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude';
}

/**
 * 组装 claude CLI 的启动参数 + 净化后 env（--print 与 PTY 交互式两种驱动共用的单一源）。
 * interactive=true 时省略 --print/stream-json 一族 flag，其余（model/effort/resume/MCP/
 * append-system-prompt/env 净化）逐字相同——保证两条供电线路下 CC 的行为一致。
 * Uses state.sessionId for --resume (v1 send-time respawn pattern).
 * env: delete OAuth tokens → merge providerEnv (prevents API routing mistakes).
 */
export function buildLaunch(state, { interactive = false, ignoreBin = false } = {}) {
  const { meta, sessionId } = state;

  // Fixed args (CC CLI v2.1.143+): --verbose required for stream-json
  const args = [];
  if (!interactive) {
    args.push(
      '--print', '--verbose',
      // --include-partial-messages：额外吐 stream_event（content_block_start/delta 等），
      // 让 cc-pool 能拿到「真·首字」时戳，把 init→首条完整消息这一坨拆成 ttfb_ms（死等）
      // + think_ms（思考生成）。纯加法：最终整条 assistant/result 事件照旧发，下游零影响。
      '--include-partial-messages',
      '--input-format=stream-json', '--output-format=stream-json',
    );
  }
  args.push('--dangerously-skip-permissions');
  // Pass --model when confirmed. 显式 meta.passModelFlag 优先于 registry 查询 —— 让未入库的
  // 新 provider（verify 时的临时 actor）也能带正确 --model 完成验证，不再依赖 verified.at 引导值。
  const resolved = meta.model ? resolveByModel(meta.model) : {};
  const passFlag = meta.passModelFlag ?? resolved.passFlag;   // 显式优先
  if (meta.model && passFlag) args.push('--model', meta.model);
  // Guard：meta.model 已从 manifest 退役（如 4.7→4.8 切换删了 4.7）。旧 session 的 JSONL 里
  // 存着旧模型签名的 thinking 块，--resume 重放到新默认模型会 400（thinking blocks cannot be
  // modified）+ 永久中毒。此时不 --resume，起干净 session——新 session_id 会被 cc-pool 的
  // init 事件捕获回写覆盖旧的（cc-pool.mjs:302），自动治愈跨版本中毒。
  const modelRetired = meta.model && !('passFlag' in resolved);
  // Pass --effort（low/medium/high/xhigh/max）控制思考预算；缺省 → CLI 默认
  if (meta.effort) args.push('--effort', meta.effort);
  if (sessionId && !modelRetired) args.push('--resume', sessionId);

  // MCP 严格化：禁止 CC 加载用户全局 MCP 配置（claude.ai 云端 Gmail/Drive/Calendar 等会卡住 turn）
  // strict 模式下，data/mcp-config.json 是【所有 CC 终端唯一的 MCP 入口】——
  // ~/.claude.json 和 <project>/.mcp.json 都被忽略。新增全局 MCP 需直接编辑该文件。
  // 见 docs/mcp.md
  args.push('--strict-mcp-config');
  // slim 主提示替换（constitution-1k 线，2026-07-16）：data/system-prompt.md 存在即整体替换
  // CC 原生主提示（13.7k 字符教学文案 → 约 500 字符宪法），并拼一行动态环境事实（日期/项目路径
  // 是原生 Environment 段里唯一真必要的信息，宪法是静态文件带不了）。文件存在与否即开关，
  // 删文件立即回到原生主提示（下次 respawn 生效），无需动代码。
  const spFile = new URL('../../../data/system-prompt.md', import.meta.url).pathname;
  if (existsSync(spFile)) {
    const envLine = `\n\n今天 ${new Date().toISOString().slice(0, 10)}；项目 ${meta.projectPath || '(未指定)'}；平台 ${process.platform}。`;
    args.push('--system-prompt', readFileSync(spFile, 'utf8').trim() + envLine);
  }
  // 审阅约定：MCC 靠回复里的 [SHARE:路径] 标记弹出审阅卡，批注以「### 对 xxx 的批注」投回
  let appendSys = REVIEW_RULE;
  if (process.env.MCC_MCP_CONFIG && existsSync(process.env.MCC_MCP_CONFIG)) {
    args.push('--mcp-config', process.env.MCC_MCP_CONFIG);
    args.push('--disallowed-tools', 'AskUserQuestion');
    appendSys += '\n当你需要向用户提问、让用户做选择或确认时，请调用 mcp__mcc__ask_user 工具（不要用 AskUserQuestion，它在本环境已禁用）。该工具会阻塞等待真人回答。';
  } else {
    args.push('--mcp-config', '{"mcpServers":{}}');
  }

  // lightweight：清空全局记忆源（CLAUDE.md / .claude/rules / 全局 resources），
  // 让 advisor 后续通过 appendSystemPrompt 拼装定制 memory pack
  if (meta.lightweight) args.push('--setting-sources', '');
  // appendSystemPrompt：由调用方注入的定制系统提示，与 MCP 提示拼接
  if (typeof meta.appendSystemPrompt === 'string' && meta.appendSystemPrompt.trim()) {
    appendSys = appendSys ? appendSys + '\n\n' + meta.appendSystemPrompt : meta.appendSystemPrompt;
  }
  if (appendSys) args.push('--append-system-prompt', appendSys);

  // env cleanup: start from process.env, remove OAuth tokens, then apply providerEnv
  const env = { ...process.env };
  // These take precedence over ANTHROPIC_API_KEY — must remove before merging providerEnv
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.MCC_OWNER = 'v2';  // 所有权标记，V1 跨进程巡查读 /proc/<pid>/environ 跳过非自家进程
  env.MCC_ACTOR_ID = state.actorId;  // MCP 子孙进程（mcp-ask-server）通过 env 拿到 actor
  env.MCC_CORE_PORT = String(process.env.MCC_PORT || 47834);
  // MCP 超时拉到 30 min：ask_user 要等真人点击，远超 CC 默认 60s
  env.MCP_TIMEOUT = '1800000';
  env.MCP_TOOL_TIMEOUT = '1800000';
  env.ANTHROPIC_LOG = 'info';  // 让 Anthropic SDK 把 429/529/retry-after 打到 stderr(已被 cc-pool 接住→pool_trace),用于区分限流 vs 排队
  if (meta.providerEnv) {
    Object.assign(env, meta.providerEnv);
    // Explicit empty-string overrides from providerEnv should also be removed
    if (env.ANTHROPIC_AUTH_TOKEN === '') delete env.ANTHROPIC_AUTH_TOKEN;
    if (env.CLAUDE_CODE_OAUTH_TOKEN === '') delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // .env 里留空的模型变量(set -a 或 systemd EnvironmentFile 会导出成空串)不传给 claude,免得空 key 顶掉本机登录
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) if (env[k] === '') delete env[k];
  if (meta.geneExclude?.length) env.GENE_EXCLUDE = meta.geneExclude.join(',');

  // meta.bin：可选的 CC 替身二进制（drop-in 冒充 claude，同 stream-json 协议）。
  // 用于"白板召回"等特殊 actor——它内部起真 claude、只换上下文加载。
  // 不传 bin → findClaude()，与今天逐字节相同（加法、零影响普通 actor）。
  // ignoreBin：PTY × memex(wb-claude/wb-worker) 组合——bin 是 JSON 帧中间人、不说终端语，
  //   cc-pool 不 spawn 它，改起真 claude，memex 注入由 pty-memex.mjs 在 cc-pool 进程内做（见 process-pty.mjs）。
  const claudePath = (ignoreBin ? findClaude() : (meta.bin || findClaude()));
  return { claudePath, args, env, cwd: meta.projectPath || undefined };
}

/**
 * per-actor 抓包代理:起一次、跨 --print respawn 复用同一个(端口不翻腾),结果挂到 state。
 * 让 ctx-inspector 对原生 CC 也走 capture 路逐字保真(真实 system + 项目/全局 CLAUDE.md)。
 *
 * 红线:
 * - fail-open——startCaptureProxy 返回 null(无 curl / server 起失败 / 上游 URL 解析失败)→
 *   state.captureProxy=null,调用方据此【不覆盖 ANTHROPIC_BASE_URL】裸跑,终端照常可用。
 * - 上游 = trueUpstream(buildLaunch 里 providerEnv 合并【之后】的 ANTHROPIC_BASE_URL,
 *   即该 actor 子进程本应用的真实上游),不依赖 process.env(per-provider override 会让它出错)。
 * - 只在原生路(meta.bin 为空)起;wb-claude/wb-worker(meta.bin 替身,已自带进程内抓包)与
 *   PTY 驱动路不在此函数内(PTY 走 spawnPtyCC)→ 天然不碰。
 *
 * 落盘目录与 api-actors.mjs captureFilePath 完全一致:$MEMEX_STATE_DIR/<actorId>/(缺省
 * ~/.cache/memex/actors/<actorId>/),故 ctx-inspector 零改动即生效。
 */
async function ensureCaptureProxy(state, trueUpstream) {
  // /model 跨 provider 切换会换真实上游——缓存代理若还钉着旧上游,请求会打错家(如
  // DeepSeek key 发给 Anthropic → 401)。上游变了就关旧建新,同上游才跨 respawn 复用。
  if (state._captureUpstream !== undefined && state._captureUpstream !== trueUpstream) {
    closeCaptureProxy(state);
    state._captureUpstream = undefined;
  }
  // 已解析过(对象或 null)且上游未变 → 直接复用,不重起。
  if (state.captureProxy !== undefined) return state.captureProxy;
  if (!state._captureProxyPromise) {
    state._captureUpstream = trueUpstream;
    const gen = state._captureGen = (state._captureGen || 0) + 1;
    const base = process.env.MEMEX_STATE_DIR || path.join(homedir(), '.cache', 'memex', 'actors');
    const stateDir = path.join(base, state.actorId);
    const log = (line) => console.log(`[cc:${state.actorId}] ${line}`);
    state._captureProxyPromise = startCaptureProxy({ stateDir, upstream: trueUpstream, log })
      .then((p) => {
        // 启动期间上游又变了(代已过期)→ 该代理作废,不写回 state
        if (state._captureGen !== gen) { try { p?.close?.(); } catch { /* noop */ } return null; }
        state.captureProxy = p || null; return state.captureProxy;
      })
      .catch((e) => { console.error(`[cc:${state.actorId}] capture 启动异常,裸跑 ${e?.message}`); if (state._captureGen === gen) state.captureProxy = null; return null; });
  }
  return state._captureProxyPromise;
}

/**
 * Spawn a CC subprocess for the given state (--print 驱动，默认线路).
 * async:原生路需先备好 per-actor 抓包代理(server.listen 是异步)再 spawn,
 * 这样首轮起即被代理覆盖、turn-first 从第一轮就抓到。代理失败则裸跑(fail-open)。
 */
export async function spawnCC(state) {
  const { claudePath, args, env, cwd } = buildLaunch(state);

  // 原生路(meta.bin 为空)挂 per-actor 抓包:upstream = providerEnv 合并后的真实上游。
  // meta.bin 替身二进制自带进程内抓包,不在此覆盖(只动原生真 claude 路)。
  // 默认关：设 MCC_CAPTURE=1 才经本地代理抓包（供上下文检视器逐字查看请求体；会落盘到 ~/.cache）
  if (!state.meta?.bin && process.env.MCC_CAPTURE === '1') {
    const trueUpstream = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const proxy = await ensureCaptureProxy(state, trueUpstream);
    if (proxy?.baseURL) env.ANTHROPIC_BASE_URL = proxy.baseURL;   // 失败=null → 保持真实上游裸跑
  }

  const child = spawn(claudePath, args, {
    env,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  state.setRunning(child.pid);
  console.log(`[cc-pool] spawned CC child pid=${child.pid} actor=${state.actorId} resume=${!!state.sessionId} capture=${!!state.captureProxy}`);
  return child;
}

/**
 * actor 删除/归档 gone 时释放抓包代理(关 http server,端口归还)。幂等、永不抛。
 */
export function closeCaptureProxy(state) {
  try { state?.captureProxy?.close?.(); } catch { /* close 永不致命 */ }
  if (state) { state.captureProxy = undefined; state._captureProxyPromise = null; }
}
