// process-pty.mjs — PTY 驱动：tmux 里跑交互式 claude（走订阅额度，6/15 计费分离备灾线路）
//
// 设计：duck-type ChildProcess 的被用表面（stdin.write / stdout 'data' / stderr / kill /
// exitCode / signalCode / pid / on('exit'|'error')），cc-pool / controls / stdin.mjs 零改动——
// 上层仍以为自己在喂 --print 子进程。切换驱动 = 换 attachChild 里一行 spawn 调用。
//
//   输入：user 帧 → tmux load-buffer + paste-buffer -p（多行安全）+ 延时 Enter
//         control_request interrupt 帧 → tmux send-keys Escape
//   输出：Stop hook（--settings 注入）回调追加 stop 文件 → 权威回合结束信号
//         （自带 transcript_path + session_id，实测 2026-06-12 CLI 2.1.167）
//         回合内轮询 transcript jsonl 增量 → 翻译成 stream-json 同形事件（init/assistant/result）
//   打断：Esc 不触发 Stop hook（实测）→ 发 Esc 后 3s 兜底定时器合成 result
//   保活：tmux session 常驻、claude 不退出（与 --print 每轮自退相反）；
//         session 死亡轮询 → emit 'exit' → cc-pool 下轮 deliverOne respawn（--resume 续接）
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  writeFileSync, readFileSync, existsSync, mkdirSync, statSync, rmSync,
  openSync, readSync, closeSync, chmodSync,
} from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLaunch } from './process.mjs';
// 开源版不带 memex 记忆注入层：恒关
const isMemexBin = () => false;
const PtyMemex = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const PTY_DIR = path.join(ROOT, 'sockets', 'pty');

/** 驱动选路：meta.driver 单 actor 覆盖 > CC_DRIVER 全局开关 > 默认 print */
export function usePtyDriver(meta) {
  if (meta?.driver) return meta.driver === 'pty';
  return process.env.CC_DRIVER === 'pty';
}

export function spawnPtyCC(state) {
  const child = new PtyChild(state);
  console.log(`[cc-pool] spawned PTY claude session=${child.session} actor=${state.actorId} resume=${!!state.sessionId}`);
  return child;
}

// ── tmux 原语（spawnSync：均为 ms 级本地命令，不阻塞事件循环可感知时长）──────────
function tmux(...argv) {
  return spawnSync('tmux', argv, { encoding: 'utf-8' });
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class PtyChild extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
    this.actorId = state.actorId;
    this.session = `mcc-pty-${state.actorId}`;
    this.exitCode = null;
    this.signalCode = null;
    this.pid = null;
    // duck-type 表面：stdout 只 emit 完整 JSONL 行（stream.mjs 行解析器照常工作）
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();           // PTY 模式无 stderr 流，永不触发
    this.stdin = { write: (line) => this._onFrame(line) };

    this._ready = false;                        // 交互 UI 就绪（信任/权限提示已应答）
    this._segFresh = true;                       // 路 A：下一条用户消息是本段第一条（需带段-start 块=地图+快照）；
                                                 //       段内后续轮裸文本，段结算焊 /clear 后复位 true
    this._pendingInjects = [];                  // ready 前到达的消息排队
    this._turnActive = false;
    this._turnStart = 0;
    this._initEmitted = false;                  // per-turn：init 事件已合成
    this._sessionId = null;                     // 本会话 uuid（_start 定：resume 沿用旧的，否则自生成）
    this._transcript = null;                    // 确定性 transcript 路径 <slug>/<uuid>.jsonl（_start 定）
    this._offset = 0;                           // transcript 增量读取游标
    this._lineBuf = '';
    this._seenMsgIds = new Set();               // usage 去重：同一 API message 多行只记一次 usage
    this._lastUsage = null;
    this._stopFile = path.join(PTY_DIR, `${this.actorId}.stop`);
    this._stopOffset = 0;
    this._turnTimers = [];                      // 回合内轮询器（transcript/stop/兜底），回合结束清
    this._lifeTimers = [];                      // 生命周期轮询器（就绪/保活），_die 时清

    // memex 终端（meta.bin=wb-claude/wb-worker × driver=pty）：cc-pool 不 spawn bin（JSON 帧中间人
    // 不说终端语），改起真 claude + 在本进程内做 wb-claude 同款注入/存档（见 pty-memex.mjs）。
    this._memex = isMemexBin(state.meta) ? new PtyMemex(state) : null;
    if (this._memex) {
      // 先 await 引擎加载 + 基因块（_start 要把基因块拼进 --append-system-prompt），再启 tmux。
      this._memex.ready.then(() => this._start()).catch((e) => setImmediate(() => this.emit('error', e)));
    } else {
      try { this._start(); } catch (e) {
        // 与 spawn ENOENT 同语义：异步 emit 'error'，cc-pool 的故障隔离/gone 归档照常工作
        setImmediate(() => this.emit('error', e));
      }
    }
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────
  _start() {
    // memex 终端：ignoreBin → 起真 claude（非 wb-claude 中间人）。基因块 + 白板纪律拼进
    // --append-system-prompt（走 system 段、会话期不变），auto-memory 关掉让注入的地图独占记忆。
    const { claudePath, args, env, cwd } = buildLaunch(this.state, { interactive: true, ignoreBin: !!this._memex });
    if (this._memex) {
      const geneAppend = this._memex.geneAppend();
      const ai = args.indexOf('--append-system-prompt');
      if (ai >= 0 && ai + 1 < args.length) args[ai + 1] += '\n\n' + geneAppend;
      else args.push('--append-system-prompt', geneAppend);
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      // P1a 路 A：甩 user 级 V1 化石（~/.claude/CLAUDE.md + rules，~26K），只保留项目 CLAUDE.md/rules
      // （第②摞）。角色基因/身份/红线已在 geneAppend（第③摞，--append-system-prompt 经 /clear 存活，
      // 探针 Q1），不依赖 user 层。去重：meta.lightweight 已 push '--setting-sources' 时不重复。
      if (!args.includes('--setting-sources')) args.push('--setting-sources', 'project');
    }

    // 确定性 transcript：共享 cwd 下按 mtime 扫目录在并发首轮会锁到别家 jsonl（实测君 cc_1781175533076
    // 的回复被串给本终端）。改为显式控制 session-id —— transcript 路径从此可推算，扫描启发式删除。
    //   · resume（buildLaunch 已加 --resume）：实测 CLI 2.1.167 resume 不 fork，仍写 <旧uuid>.jsonl
    //   · 否则（新会话 / modelRetired 起干净 session）：自生成 uuid 经 --session-id 钉死，写 <新uuid>.jsonl
    // 判据用 args 是否含 --resume，直接复用 buildLaunch 的决策（含 modelRetired guard），不重复推断。
    const resuming = args.includes('--resume');
    this._sessionId = resuming ? this.state.sessionId : randomUUID();
    if (!resuming) args.push('--session-id', this._sessionId);
    const slug = (cwd || process.cwd()).replace(/[/.]/g, '-');
    this._transcript = path.join(homedir(), '.claude', 'projects', slug, `${this._sessionId}.jsonl`);

    if (cwd && !existsSync(cwd)) {
      const err = new Error(`spawn ENOENT: cwd ${cwd} 不存在`);
      err.code = 'ENOENT';
      throw err;
    }
    mkdirSync(PTY_DIR, { recursive: true });
    rmSync(this._stopFile, { force: true });

    // Stop hook → 追加 stop 文件（hook stdin JSON 自带 transcript_path/session_id）
    const settingsFile = path.join(PTY_DIR, `${this.actorId}.settings.json`);
    writeFileSync(settingsFile, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `cat >> ${shq(this._stopFile)}; echo >> ${shq(this._stopFile)}` }] }] },
    }));
    args.push('--settings', settingsFile);

    // tmux 2.7 无 -e 传 env；launch 脚本 env -i 全量替换（与 spawn 的 env 选项语义一致）
    const envArgs = Object.entries(env)
      .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')
      .map(([k, v]) => `${k}=${shq(v)}`);
    const launchFile = path.join(PTY_DIR, `${this.actorId}.sh`);
    writeFileSync(launchFile, [
      '#!/bin/bash',
      `exec env -i \\\n  ${envArgs.join(' \\\n  ')} \\\n  ${shq(claudePath)} ${args.map(shq).join(' ')}`,
      '',
    ].join('\n'));
    chmodSync(launchFile, 0o700);

    tmux('kill-session', '-t', this.session);   // 残留同名 session（pool 崩溃遗留）先清
    const r = tmux('new-session', '-d', '-s', this.session, ...(cwd ? ['-c', cwd] : []), 'bash', launchFile);
    if (r.status !== 0) {
      const err = new Error(`tmux new-session failed: ${(r.stderr || '').trim()}`);
      err.code = 'ENOENT';
      throw err;
    }
    const pane = tmux('list-panes', '-t', this.session, '-F', '#{pane_pid}');
    this.pid = parseInt(pane.stdout) || null;
    this.state.setRunning(this.pid);

    // 就绪看门人：应答信任/bypass 提示直到主界面出现（spike 实测过 Down/Enter 时序要分步）
    const readyPoll = setInterval(() => this._readyTick(), 800);
    this._lifeTimers.push(readyPoll);
    // 60s 仍未识别就绪 → 放行排队消息（宁可注入也不无限扣押）
    this._lifeTimers.push(setTimeout(() => { if (!this._ready) this._markReady('timeout'); }, 60_000));
    // 保活：tmux session 死亡（claude /exit、崩溃、外部 kill）→ exit 语义交还 cc-pool
    this._lifeTimers.push(setInterval(() => {
      if (tmux('has-session', '-t', this.session).status !== 0) this._die(1, null);
    }, 5000));
  }

  _readyTick() {
    if (this._ready) return;
    const cap = tmux('capture-pane', '-t', this.session, '-p');
    if (cap.status !== 0) return;
    const pane = cap.stdout || '';
    if (/bypass permissions on|\? for shortcuts/.test(pane)) { this._markReady('ui'); return; }
    if (/trust this folder/.test(pane)) {
      // 信任提示：默认项即 "Yes, I trust" → Enter
      if (/❯ 1\. Yes/.test(pane)) tmux('send-keys', '-t', this.session, 'Enter');
      return;
    }
    if (/Yes, I accept/.test(pane)) {
      // bypass 权限警告：默认选中 "No, exit"，需先 Down 再下个 tick Enter（分步防时序误选）
      if (/❯ .*Yes, I accept/.test(pane)) tmux('send-keys', '-t', this.session, 'Enter');
      else tmux('send-keys', '-t', this.session, 'Down');
    }
  }

  _markReady(via) {
    this._ready = true;
    console.log(`[cc-pool] PTY ${this.actorId} ready (${via})`);
    for (const t of this._pendingInjects.splice(0)) this._inject(t);
  }

  kill(signal = 'SIGTERM') {
    tmux('kill-session', '-t', this.session);
    this._die(null, signal);
  }

  _die(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this._clearTurnTimers();
    for (const t of this._lifeTimers.splice(0)) clearInterval(t), clearTimeout(t);
    this.emit('exit', code, signal);
  }

  // ── 输入侧：stream-json 帧 → tmux 按键 ────────────────────────────────────
  _onFrame(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
      tmux('send-keys', '-t', this.session, 'Escape');
      // Esc 不触发 Stop hook（实测）→ 3s 后兜底收口本回合
      this._turnTimers.push(setTimeout(() => {
        if (this._turnActive) this._finishTurn('interrupt');
      }, 3000));
      return;
    }
    if (frame.type !== 'user') return;
    const blocks = frame.message?.content || [];
    const text = blocks.map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[图片附件：PTY 模式暂不支持内联，已忽略]';
      return '';
    }).filter(Boolean).join('\n');

    this._beginTurn();
    this._mxUserText = text;     // memex 存档用原始用户文本（不含注入块）
    if (this._memex) {
      // 路 A 注入分层：仅「本段第一条用户消息」（_segFresh）拼段-start 块（地图+携带快照）在前；
      // 段内后续轮裸文本（对话靠交互式 REPL 累积，不再每轮重 paste 全段）。段结算焊 /clear 后复位
      // _segFresh=true → 下条重注入。segStartBlock 同步纯文件读，引擎动态加载 async → 经 ready 闸；
      // 引擎/读盘异常或非段首 → 裸文本注入，绝不卡死回合。
      this._memex.ready.then(() => {
        let full = text;
        if (this._segFresh) {
          try { const blk = this._memex.segStartBlock(); if (blk) full = blk + '\n\n' + text; } catch {}
          this._segFresh = false;
        }
        if (this._ready) this._inject(full); else this._pendingInjects.push(full);
      }).catch(() => { if (this._ready) this._inject(text); else this._pendingInjects.push(text); });
      return;
    }
    if (this._ready) this._inject(text);
    else this._pendingInjects.push(text);
  }

  _inject(text) {
    const msgFile = path.join(PTY_DIR, `${this.actorId}.msg`);
    writeFileSync(msgFile, text || '(空消息)');
    const buf = `mcc-${this.actorId}`;
    tmux('load-buffer', '-b', buf, msgFile);
    tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', this.session);
    // 提交确认环：盲发一次 Enter 不可靠（刚 ready 时 REPL 可能还在消化 paste，Enter 被吞；
    // 而 paste 渲染进输入框也有延迟，早期 tick 看不到文本 ≠ 已提交——两个时序坑均实测踩过，
    // 2026-06-12）。状态机：先等文本出现在输入框行（❯ 开头），出现即发 Enter，消失才算提交。
    const frag = (text || '(空消息)').split('\n')[0].slice(0, 30);
    let tries = 0, seen = false;
    const iv = setInterval(() => {
      if (++tries > 25) { clearInterval(iv); return; }
      const cap = tmux('capture-pane', '-t', this.session, '-p');
      if (cap.status !== 0) return;
      // 大段 paste 会被 TUI 折叠成 "❯ [Pasted text #1 +N lines]" 占位符，原文片段不会出现在输入框
      // （92KB 真机实锤，2026-06-12）——占位符同样算 pending。
      const pending = (cap.stdout || '').split('\n').some((l) => l.trimStart().startsWith('❯') && (l.includes(frag) || l.includes('[Pasted text')));
      if (pending) { seen = true; tmux('send-keys', '-t', this.session, 'Enter'); }
      else if (seen) clearInterval(iv);   // 见过又消失 = 真提交；没见过 = paste 还没渲染，继续等
    }, 600);
    this._turnTimers.push(iv);
  }

  // 路 A·P2：段结算后在【回合之间】（turn 不活跃）向 REPL 发 /clear 控制命令坍缩对话历史，复位
  // _segFresh → 下条用户消息重注入段-start 块开新段。/clear 是短斜杠命令（不会被 TUI 折叠），复用
  // _inject 同款 load-buffer/paste/确认环提交（但走独立 buffer，不经 _inject → 不污染上层捕获/计数）。
  _sendClear() {
    this._segFresh = true;
    const buf = `mcc-${this.actorId}-clr`;
    const clrFile = path.join(PTY_DIR, `${this.actorId}.clr`);
    try {
      writeFileSync(clrFile, '/clear');
      tmux('load-buffer', '-b', buf, clrFile);
      tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', this.session);
    } catch { return; }
    let tries = 0, seen = false;
    const iv = setInterval(() => {
      if (++tries > 15) { clearInterval(iv); return; }
      const cap = tmux('capture-pane', '-t', this.session, '-p');
      if (cap.status !== 0) return;
      const pending = (cap.stdout || '').split('\n').some((l) => l.trimStart().startsWith('❯') && l.includes('/clear'));
      if (pending) { seen = true; tmux('send-keys', '-t', this.session, 'Enter'); }
      else if (seen) clearInterval(iv);
    }, 400);
    this._lifeTimers.push(iv);   // 回合间发送,挂生命周期定时器(非 _turnTimers,免被下回合 _beginTurn 清掉)
  }

  _beginTurn() {
    this._turnActive = true;
    this._turnStart = Date.now();
    this._initEmitted = false;
    this._turnSawAssistant = false;
    this._hookLastMsg = null;
    this._emittedText = new Set();   // 本轮已 emit 到面板的文本块（裁剪后），收口兜底去重用
    this._seenMsgIds.clear();
    // memex 回合累积：reply（assistant 文本，去重）+ dp（工具调用决策路径，按 tool_use id 去重）
    this._mxReply = [];
    this._mxSeenReply = new Set();
    this._mxDp = [];
    this._mxSeenTools = new Set();
    this._clearTurnTimers();
    this._turnTimers.push(setInterval(() => this._pollStop(), 300));
    this._turnTimers.push(setInterval(() => this._pollTranscript(), 400));
  }

  _clearTurnTimers() {
    for (const t of this._turnTimers.splice(0)) clearInterval(t), clearTimeout(t);
  }

  // ── 输出侧：Stop hook 文件 + transcript jsonl → stream-json 同形事件 ───────
  _pollStop() {
    let size;
    try { size = statSync(this._stopFile).size; } catch { return; }
    if (size <= this._stopOffset) return;
    const chunk = this._readSlice(this._stopFile, this._stopOffset, size);
    this._stopOffset = size;
    for (const ln of chunk.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const hook = JSON.parse(ln);
        if (hook.transcript_path) this._lockTranscript(hook.transcript_path);
        if (hook.last_assistant_message) this._hookLastMsg = hook.last_assistant_message;
      } catch {}
    }
    this._finishTurn(null);
  }

  _pollTranscript() {
    // _transcript 在 _start 即确定性钉死，无需扫描；Stop hook 的权威路径仅作兜底校正（_lockTranscript）
    this._drainTranscript();
  }

  _lockTranscript(p) {
    if (this._transcript === p) return;
    this._transcript = p;
    this._offset = 0;          // 新文件从头读：行内 timestamp 过滤掉 resume 带入的历史
    this._lineBuf = '';
  }

  _drainTranscript() {
    if (!this._transcript) return;
    let size;
    try { size = statSync(this._transcript).size; } catch { return; }
    // 截断自愈：claude resume 启动可能整文件重写，size 变小 → 游标悬空会永久漏读。
    // 归零重读，timestamp 闸挡住历史行重放（疑似 2026-06-12 ⑤ 阶段偶发漏"7"的根因）。
    if (size < this._offset) { this._offset = 0; this._lineBuf = ''; }
    if (size <= this._offset) return;
    const chunk = this._readSlice(this._transcript, this._offset, size);
    this._offset = size;
    const lines = (this._lineBuf + chunk).split('\n');
    this._lineBuf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let rec;
      try { rec = JSON.parse(ln); } catch { continue; }
      this._onTranscriptLine(rec);
    }
  }

  _onTranscriptLine(rec) {
    if (rec.type !== 'assistant' || !rec.message) return;
    // resume 被打断的回合时 claude 会补一条合成占位（"No response requested."），不是真输出
    if (rec.message.model === '<synthetic>') return;
    // timestamp 闸：resume/历史行不重放（等价 --print 驱动的 sawInit 闸）
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (ts && ts < this._turnStart - 3000) return;
    this._emitInit(rec.message.model);
    const msg = { ...rec.message };
    // 同一 API message 在 transcript 里按 content block 拆多行、usage 重复——只首行保留，
    // 防 cc-pool 的 turnUsage 累计被翻倍
    const mid = msg.id || rec.uuid;
    if (this._seenMsgIds.has(mid)) delete msg.usage;
    else { this._seenMsgIds.add(mid); if (msg.usage) this._lastUsage = msg.usage; }
    this._turnSawAssistant = true;
    // 记下已 emit 的文本块（裁剪后），供 _finishTurn 权威兜底去重——别和 memex 累积耦合（那条受 _memex 闸控）
    for (const b of (msg.content || [])) {
      if (b.type === 'text' && b.text.trim()) this._emittedText.add(b.text.trim());
    }
    // memex 存档累积：assistant 文本块（去重，作 a 兜底）+ tool_use（按 id 去重 → dp 决策路径）
    if (this._memex) {
      for (const b of (msg.content || [])) {
        if (b.type === 'text' && b.text.trim()) {
          const t = b.text.trim();
          if (!this._mxSeenReply.has(t)) { this._mxSeenReply.add(t); this._mxReply.push(t); }
        } else if (b.type === 'tool_use' && b.id && !this._mxSeenTools.has(b.id)) {
          this._mxSeenTools.add(b.id);
          this._mxDp.push(`[调用 ${b.name} ${JSON.stringify(b.input || {}).slice(0, 300)}]`);
        }
      }
    }
    this._emitEvent({ type: 'assistant', message: msg });
  }

  _emitInit(model) {
    if (this._initEmitted) return;
    this._initEmitted = true;
    const sid = this._transcript ? path.basename(this._transcript, '.jsonl') : this.state.sessionId;
    this._emitEvent({ type: 'system', subtype: 'init', session_id: sid, model: model || this.state.model });
  }

  _finishTurn(stopReason) {
    if (!this._turnActive) return;
    this._drainTranscript();                    // 收尾前最后吸一次增量，防 stop 先于轮询到达
    this._turnActive = false;
    this._clearTurnTimers();
    if (!this._initEmitted && this._transcript) this._emitInit(null);  // 零输出回合也要回写 sessionId
    // 收口 force-flush：最后一行最终答案常无换行符被 parked 在 _lineBuf（重负载下 Stop 抢在换行落盘前），
    // _drainTranscript 永不 emit 它 → 解析补发,走正常路径(带 usage/memex 记账)。
    if (this._lineBuf && this._lineBuf.trim()) {
      try { this._onTranscriptLine(JSON.parse(this._lineBuf)); this._lineBuf = ''; } catch {}
    }
    // 权威兜底：Stop hook 的 last_assistant_message 是存档级权威源。force-flush 后它（裁剪后）若仍不在
    // 本轮已 emit 文本集 → 补发,保证面板与存档一致(覆盖 transcript 整条没落盘 + 旧"零输出"两种情形)。
    const authoritative = (this._hookLastMsg || '').trim();
    if (authoritative && !this._emittedText.has(authoritative)) {
      this._emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: authoritative }] } });
      this._emittedText.add(authoritative);
    }
    // memex 存档 + 自然边界结算：a 优先用 Stop hook 的 last_assistant_message（权威最终回复），
    // 兜底拼累积文本块；dp = 本轮工具调用（无工具=纯对话轮，dp 空）。settle 含 LLM → fire-and-forget
    // （内部串行锁防重入），不阻塞 result 事件回流。
    // 路 A·P2：结算成功（settled=true）→ 焊 /clear 坍缩 REPL 对话历史 + 复位 _segFresh，下条用户消息
    // 重注入段-start 块（地图+新快照）开新段。append 基因经 /clear 存活（探针 Q1），不必重发。
    // /clear 排在 result emit 之后发（回合已收口、turn 不活跃），不打断正在显示的回复。
    if (this._memex && this._memex._mind) {
      const a = (this._hookLastMsg || this._mxReply.join('\n')).trim();
      const dp = this._mxDp.join('\n');
      try { this._memex.archive(this._mxUserText, a, dp); } catch {}
      this._memex.maybeSettle().then((settled) => { if (settled) this._sendClear(); }).catch(() => {});
    }
    this._hookLastMsg = null;
    this._emitEvent({
      type: 'result',
      duration_ms: Date.now() - this._turnStart,
      usage: this._lastUsage,
      stop_reason: stopReason,
      // 无 total_cost_usd：订阅额度线路没有 API 计价，cc-pool 对 null 自然跳过
    });
  }

  _emitEvent(ev) {
    this.stdout.emit('data', Buffer.from(JSON.stringify(ev) + '\n'));
  }

  _readSlice(file, from, to) {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf-8', 0, n);
    } finally { closeSync(fd); }
  }
}
