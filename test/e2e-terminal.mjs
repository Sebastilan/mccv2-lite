// e2e-terminal.mjs — 真机端到端:建终端 → 派活 → 审阅卡 → 批注 → 重交,采样进程树内存并汇总用量
// 用法: npm run e2e -- <cc|codex|life|chat> [--model <名>] [--out <结果.json>](即 node test/e2e-terminal.mjs …);结束自清理,不留数据
// 在临时副本里起服务(随机端口、临时工作区),不碰本仓 data/。会真调模型(花额度),需要对应终端已配好(见 AGENTS.md)。
// 内存口径:该种终端的池进程 + 它的全部子孙(adapter、codex/claude 等 CLI)的 RSS 之和(含共享库,会略高估);
//   基线 = 服务起来、尚无终端时池进程的 RSS;空闲 = 任务做完后等 4 秒的值;峰值 = 全程采样(每 200ms)的最大值。
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const kind = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!['cc', 'codex', 'life', 'chat'].includes(kind)) { console.error('用法: node test/e2e-terminal.mjs <cc|codex|life|chat> [--model 名] [--out 文件]'); process.exit(2); }
const model = opt('--model');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POOL_PID = { cc: 'cc-pool.pid', codex: 'codex-pool.pid', life: 'life-pool.pid', chat: 'chat-pool.pid' }[kind];

// ── 进程树 RSS(KB):从 pid 起把子孙全加起来 ──
function tree(rootPid) {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
  const kids = new Map(), rss = new Map(), comm = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [pid, ppid] = [+m[1], +m[2]];
    rss.set(pid, +m[3]); comm.set(pid, m[4]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let sum = 0; const names = [];
  const walk = (p) => { if (!rss.has(p)) return; sum += rss.get(p); names.push(comm.get(p)); for (const c of kids.get(p) || []) walk(c); };
  walk(rootPid);
  return { kb: sum, names };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-e2e-'));
for (const d of ['server', 'web', 'protocol', 'scripts', 'bin', 'package.json']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
spawnSync(process.execPath, ['scripts/build-frontend.mjs'], { cwd: tmp });
const ws = path.join(tmp, 'workspace');
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCC_PORT: String(port), MCC_WORKSPACE: ws, MCC_PASSWORD: crypto.randomBytes(8).toString('hex') };   // secret-ok: 每次随机生成,只为打开鉴权
const srv = spawn(process.execPath, ['server/main.mjs'], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
for (let i = 0; i < 100 && !log.includes('ready in'); i++) await sleep(100);
if (!log.includes('ready in')) { console.error('服务没起来:\n' + log); process.exit(1); }

const B = `http://127.0.0.1:${port}`;
const call = async (p, body) => {
  const r = await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const poolPid = () => { try { return parseInt(fs.readFileSync(path.join(tmp, 'sockets', POOL_PID), 'utf8')); } catch { return null; } };

const result = { kind, model: model || '(默认)', ok: false, steps: {}, memory_kb: {} };
let peak = 0, peakNames = [], sampling = true;
(async () => { while (sampling) { const p = poolPid(); if (p) { const t = tree(p); if (t.kb > peak) { peak = t.kb; peakNames = t.names; } } await sleep(200); } })();

try {
  // 基线:池进程在,尚无终端
  for (let i = 0; i < 100 && !poolPid(); i++) await sleep(100);
  await sleep(1500);
  result.memory_kb.baseline = tree(poolPid()).kb;
  peak = 0;   // 峰值只算从建终端起

  // CC 不给 --model 时照网页的做法取 /api/provider 的默认模型(只配了 DeepSeek 就是 DeepSeek);直接建不带模型会落到 Claude 自己的默认
  const useModel = model || (kind === 'cc' ? (await call('/api/provider'))?.provider : null);
  result.model = useModel || '(默认)';
  const t0 = Date.now();
  const k = await call('/api/actors', { kind, meta: { name: `e2e-${kind}`, ...(useModel ? { model: useModel } : {}) } });   // meta 不能为空(服务端拒建空壳终端)
  if (!k?.actorId) throw new Error('建终端失败: ' + JSON.stringify(k));
  result.steps.created_s = (Date.now() - t0) / 1000;
  const report = path.join(ws, 'e2e-demo', 'report.md');
  const waitShare = async (afterId, timeoutS) => {
    const t = Date.now();
    while (Date.now() - t < timeoutS * 1000) {
      const msgs = await call(`/api/actors/${k.actorId}/messages`);
      const sh = msgs.find(m => m.kind === 'share' && m.id > afterId);
      if (sh) return { share: sh, msgs, s: (Date.now() - t) / 1000 };
      await sleep(300);
    }
    return null;
  };
  const t1 = Date.now();
  await call('/api/messages', { to_id: k.actorId, kind: 'user_msg', payload: {
    text: `请写一份三段的短文,介绍你自己是什么、能做什么、不能做什么,保存为 ${report},写好后交给我审阅。` } });
  const first = await waitShare(0, 240);
  if (!first) throw new Error('240 秒内没收到审阅卡');
  result.steps.first_share_s = (Date.now() - t1) / 1000;
  result.steps.share_file_ok = fs.existsSync(report);
  const before = fs.readFileSync(report, 'utf8');

  // 批注 → 提交 → 重交
  const token = first.share.payload.token;
  await call(`/api/review/${token}/annotate`, { anchor: before.split('\n').find(l => l.trim()) || '', text: '在这一段最后加一句话:「已按批注修改」' });
  const t2 = Date.now();
  const fb = await call(`/api/review/${token}/feedback`, {});
  result.steps.feedback_delivered = fb?.delivered;
  const second = await waitShare(first.share.id, 240);
  if (!second) throw new Error('提交批注后 240 秒内没有重交');
  result.steps.resubmit_s = (Date.now() - t2) / 1000;
  const after = fs.readFileSync(report, 'utf8');
  result.steps.file_changed = after !== before;
  result.steps.has_marker = after.includes('已按批注修改');
  result.ok = !!(first && second && result.steps.file_changed);

  await sleep(4000);   // 空闲:任务做完,稳定后
  // 用量:累加本终端各轮 turn_done 事件里的 usage(各字段原样相加)与 cost_usd(CC 自报;其余终端报 0,按 token 与官方价自算)
  const usage = { turns: 0, cost_usd: 0 };
  for (const m of await call(`/api/actors/${k.actorId}/messages`)) {
    if (m.payload?.event_type !== 'turn_done') continue;
    usage.turns++; usage.cost_usd += Number(m.payload.cost_usd) || 0;
    for (const [key, v] of Object.entries(m.payload.usage || {})) if (typeof v === 'number') usage[key] = (usage[key] || 0) + v;
  }
  result.usage = usage;
  const idle = tree(poolPid());
  result.memory_kb.idle = idle.kb; result.memory_kb.idle_procs = idle.names;
  result.memory_kb.peak = peak; result.memory_kb.peak_procs = peakNames;
  const core = tree(srv.pid); result.memory_kb.core_server_incl_pools = core.kb;
} catch (e) {
  result.error = String(e.message || e);
} finally {
  sampling = false;
  srv.kill('SIGTERM');
  if (fs.existsSync(path.join(tmp, 'sockets'))) for (const pf of fs.readdirSync(path.join(tmp, 'sockets')).filter(n => n.endsWith('.pid'))) {
    const pid = parseInt(fs.readFileSync(path.join(tmp, 'sockets', pf), 'utf8'));
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await sleep(500);
  result.workspace_copy = null;
  const out = opt('--out');
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(result.ok ? 0 : 1);
}
