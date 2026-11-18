// selftest.mjs — 离线自检：语法、相对 import、前端打包、临时副本起服务走一遍审阅链路（不联网、不调模型）
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

// 1. 语法 + 相对 import 目标存在
const SKIP = /\/(node_modules|dist|lib|vendor|data|logs)\//;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.test(p + '/') && !e.name.startsWith('.')) walk(p); }
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
})(ROOT);
let syntaxBad = 0, importBad = 0;
for (const f of files) {
  if (spawnSync(process.execPath, ['--check', f]).status !== 0) { syntaxBad++; console.log('  syntax:', path.relative(ROOT, f)); }
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) { importBad++; console.log('  import:', path.relative(ROOT, f), '->', m[1]); }
  }
}
ok(syntaxBad === 0, `语法检查 ${files.length} 个文件`);
ok(importBad === 0, '相对 import 全部可解析');

// 2. 依赖与前端打包
ok(fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3')), '依赖已安装（npm install）');
if (failed) process.exit(1);

// 3. 临时副本里起服务（随机端口、临时工作区），不碰本仓 data/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-selftest-'));
for (const d of ['src', 'adapters', 'protocol', 'scripts', 'bin', 'package.json']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
const build = spawnSync(process.execPath, ['scripts/build-frontend.mjs'], { cwd: tmp, encoding: 'utf8' });
ok(build.status === 0, '前端打包');
const ws = path.join(tmp, 'workspace');
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCC_PORT: String(port), MCC_WORKSPACE: ws };
env.MCC_PASSWORD = crypto.randomBytes(8).toString('hex');   // secret-ok: 每次随机生成，只为打开鉴权
const srv = spawn(process.execPath, ['src/main.mjs'], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 50 && !log.includes('ready in'); i++) await sleep(100);
ok(log.includes('ready in'), `服务启动（端口 ${port}）`);

const B = `http://127.0.0.1:${port}`;
const call = async (p, body) => {
  const r = await fetch(B + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, body: await r.text() };
};
try {
  for (const p of ['/', '/review.html', '/manifest.json', '/api/provider']) ok((await call(p)).status === 200, `GET ${p} 200`);
  // 审阅链路：注册分享 → 两条批注 → 提交，批注应拼成 markdown 投回 from_actor
  const f = path.join(ws, 'selftest.md'); fs.writeFileSync(f, '# 自检\n\n第一段\n\n第二段\n');
  const sh = JSON.parse((await call('/api/review/share', { path: f, from_actor: 'cc_selftest' })).body);
  ok(!!sh.token, '注册审阅文件拿到 token');
  ok((await call(`/api/review/${sh.token}`)).body.includes('第一段'), '按 token 读原文');
  await call(`/api/review/${sh.token}/annotate`, { anchor: '第一段', text: '改短一点' });
  await call(`/api/review/${sh.token}/annotate`, { anchor: '第二段', text: '删掉' });
  const fb = JSON.parse((await call(`/api/review/${sh.token}/feedback`, {})).body);
  ok(fb.ok && fb.delivered === 2 && /批注（2 条）/.test(fb.messageId?.payload?.text || ''), '提交反馈：2 条批注投回终端');
  ok((await call('/api/review/share', { path: '/etc/passwd' })).status === 400, '拒绝分享工作区与 /tmp 之外的路径');
  // 反代:同机转发进来的请求(带 X-Forwarded-For)不算本机,未登录须 401
  ok((await fetch(B + '/api/provider', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status === 401, '经反代(带转发头)的未登录请求 401');
  // 傻瓜式:新建终端不带路径,落在工作区(懒启动,不发消息不调模型)
  const na = JSON.parse((await call('/api/actors', { kind: 'cc', meta: { model: 'claude-sonnet-5' } })).body);
  const row = JSON.parse((await call('/api/actors')).body).find(a => a.id === na.actorId);
  ok(row?.meta?.projectPath === path.resolve(ws), '新建终端不选路径时落在工作区');
} finally {
  srv.kill('SIGTERM');
  for (const pf of fs.existsSync(path.join(tmp, 'sockets')) ? fs.readdirSync(path.join(tmp, 'sockets')).filter(n => n.endsWith('.pid')) : []) {
    try { process.kill(-parseInt(fs.readFileSync(path.join(tmp, 'sockets', pf), 'utf8')), 'SIGTERM'); } catch {}
    try { process.kill(parseInt(fs.readFileSync(path.join(tmp, 'sockets', pf), 'utf8')), 'SIGTERM'); } catch {}
  }
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n自检失败 ${failed} 项` : '\n自检通过');
process.exit(failed ? 1 : 0);
