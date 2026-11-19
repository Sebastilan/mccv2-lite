// api-compat.mjs — v1-compat 存根（让 v2 前端调 v1 端点不崩溃）
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { obs } from '../ops/observability.mjs';
import { json } from './_helpers.mjs';
import { getAll } from '../providers/_registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Skills 从 v1 项目读取（如果存在）
const V1_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'data', 'skills');

let _lastCpu = null;
function readCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const cols = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = cols[3];
    const total = cols.reduce((a, b) => a + b, 0);
    if (!_lastCpu) { _lastCpu = { idle, total }; return 0; }
    const dIdle = idle - _lastCpu.idle;
    const dTotal = total - _lastCpu.total;
    _lastCpu = { idle, total };
    return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  } catch { return 0; }
}

// CPU package 温度(°C);云虚机无传感器返回 null,前端据此隐藏
function readTemp() {
  try {
    const base = '/sys/class/thermal';
    for (const z of fs.readdirSync(base)) {
      if (!z.startsWith('thermal_zone')) continue;
      if (fs.readFileSync(path.join(base, z, 'type'), 'utf8').trim() !== 'x86_pkg_temp') continue;
      return Math.round(parseInt(fs.readFileSync(path.join(base, z, 'temp'), 'utf8')) / 1000);
    }
    const hbase = '/sys/class/hwmon';
    for (const h of fs.readdirSync(hbase)) {
      if (fs.readFileSync(path.join(hbase, h, 'name'), 'utf8').trim() !== 'coretemp') continue;
      return Math.round(parseInt(fs.readFileSync(path.join(hbase, h, 'temp1_input'), 'utf8')) / 1000);
    }
  } catch { /* 无传感器 */ }
  return null;
}

// 系统盘(/)占用率;顺带回传剩余/总量 GB 供 title 显示
function readDisk() {
  try {
    const st = fs.statfsSync('/');
    const total = st.blocks * st.bsize;
    const avail = st.bavail * st.bsize;
    const used = (st.blocks - st.bfree) * st.bsize;
    if (!total) return null;
    const GB = 1024 ** 3;
    return {
      pct: Math.round((used / (used + avail)) * 100),
      free_gb: Math.round(avail / GB),
      total_gb: Math.round(total / GB),
    };
  } catch { return null; }
}

function readRam() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0');
    const avail = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0');
    return total > 0 ? Math.round((1 - avail / total) * 100) : 0;
  } catch { return 0; }
}

export function handleCompatApi(req, res, { poolSupervisor } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // GET /api/provider — 返回 providers 含 models[]，供前端 dropdown 展开具体模型
  if (req.method === 'GET' && p === '/api/provider') {
    const providers = getAll();
    const firstAvail = providers.find(p => p.available);
    const defaultModel = firstAvail?.models?.[0] || 'claude-opus-5[1m]';
    json(res, { provider: defaultModel, providers });
    return true;
  }

  // GET /api/skills
  if (req.method === 'GET' && p === '/api/skills') {
    if (fs.existsSync(V1_SKILLS_DIR)) {
      try {
        const files = fs.readdirSync(V1_SKILLS_DIR).filter(f => f.endsWith('.md'));
        json(res, files.map(f => ({ name: f.replace(/\.md$/, '') })));
        return true;
      } catch {}
    }
    json(res, []);
    return true;
  }

  // GET /api/skills/:name
  if (req.method === 'GET' && p.startsWith('/api/skills/')) {
    const name = decodeURIComponent(p.slice('/api/skills/'.length));
    const skillPath = path.join(V1_SKILLS_DIR, name + '.md');
    if (fs.existsSync(skillPath)) {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(fs.readFileSync(skillPath, 'utf8'));
    } else {
      json(res, { error: 'skill not found' }, 404);
    }
    return true;
  }

  // GET /api/sysinfo
  if (req.method === 'GET' && p === '/api/sysinfo') {
    json(res, { cpu: readCpu(), ram: readRam(), temp: readTemp(), disk: readDisk() });
    return true;
  }

  // POST /api/cc-pool/restart — 只重启 cc-pool（不重启 main）
  // 走 process group SIGTERM 原子杀掉旧 pool + 全部 CC 子进程（零孤儿），再 spawn 新 pool
  // 用途：cc-pool 代码变动后让新逻辑生效，不必动 main、不必走 systemd 拉起
  if (req.method === 'POST' && p === '/api/cc-pool/restart') {
    obs.counter('cc_pool.restart');
    if (!poolSupervisor?.restartPool) {
      json(res, { error: 'pool supervisor not available' }, 500);
      return true;
    }
    poolSupervisor.restartPool()
      .then(({ oldPid, newPid }) => json(res, { ok: true, oldPid, newPid }))
      .catch(e => json(res, { error: e.message }, 500));
    return true;
  }

  // POST /api/pools/:kind/restart — 重启任意一种 pool（chat / ling / cc ...）
  //
  // 为什么需要它：pool 是 detached 进程，core 重启时 PoolRegistry 见其存活会
  // 「already alive, skipping spawn」故意跳过——所以重启 MCC **不会**让 pool 层的代码改动生效。
  // 以前只有 cc 有这条路（/api/cc-pool/restart），chat/ling 只能人肉 kill + setsid 重拉。
  if (req.method === 'POST' && /^\/api\/pools\/[a-z0-9_-]+\/restart$/.test(p)) {
    const kind = p.split('/')[3];
    obs.counter('pool.restart');
    if (!poolSupervisor?.restartPool) {
      json(res, { error: 'pool supervisor not available' }, 500);
      return true;
    }
    poolSupervisor.restartPool(kind)
      .then(({ oldPid, newPid }) => json(res, { ok: true, kind, oldPid, newPid }))
      .catch(e => json(res, { error: e.message }, 400));
    return true;
  }

  // POST /api/restart  — body 可带 {withPool:true} 一并重启 cc-pool
  // （主进程 exit 后由 systemd/pm2 拉起；main.mjs:133 启动时若 pool 已死会重新 spawn）
  if (req.method === 'POST' && p === '/api/restart') {
    obs.counter('compat.restart');
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let withPool = false;
      try { withPool = !!JSON.parse(body || '{}').withPool; } catch {}
      json(res, { ok: true, withPool });
      // 一并重启：先杀 cc-pool（pid 在 sockets/cc-pool.pid），再 graceful exit
      if (withPool) {
        try {
          const poolPid = parseInt(fs.readFileSync(path.join(__dirname, '..', '..', 'sockets', 'cc-pool.pid'), 'utf-8').trim());
          if (poolPid) { try { process.kill(poolPid, 'SIGTERM'); } catch {} }
        } catch {}
      }
      setTimeout(() => process.exit(0), 300);
    });
    return true;
  }

  return false;
}
