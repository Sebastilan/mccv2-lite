// dashboard-stats.js — 用量/系统/机器状态

import { $, state, BASE_PATH, USAGE_DANGER_THRESHOLD, USAGE_WARN_THRESHOLD, MACHINES_POLL_MS } from '../core/state.js';
import { getUsage, getZhipuUsage, getSysInfo, getMachines } from '../core/api.js';
import { formatResetCountdown } from '../utils/time.js';

export { MACHINES_POLL_MS };

// ─── 用量 ───

let _usageAccounts = [], _usageIndex = 0, _zhipuData = null, _showZhipu = false;

function usageChip(pct, resetsAt, fallback) {
  const p = Math.round(pct);
  const label = resetsAt ? formatResetCountdown(resetsAt) : fallback;
  const cls = p >= USAGE_DANGER_THRESHOLD ? 'usage-danger' : p >= USAGE_WARN_THRESHOLD ? 'usage-warn' : 'usage-ok';
  return `<span class="usage-chip ${cls}"><span class="usage-period">${label}</span><span class="usage-pct">${p}%</span></span>`;
}

function renderUsageBar() {
  const el = $('#usage-bar');
  if (!el) return;
  if (_showZhipu && _zhipuData) {
    const { level, percentage_5h, percentage_weekly, nextReset_5h, nextReset_weekly } = _zhipuData;
    el.innerHTML = `<span class="usage-chip usage-ok"><span class="usage-period">${level}</span></span>` +
      (percentage_5h != null ? usageChip(percentage_5h, nextReset_5h, '5h') : '') +
      (percentage_weekly != null ? usageChip(percentage_weekly, nextReset_weekly, '7d') : '');
    el.style.cursor = 'pointer';
    return;
  }
  if (!_usageAccounts.length) { if (_zhipuData) { _showZhipu = true; renderUsageBar(); } return; }
  const valid = _usageAccounts.filter(a => a && !a.error);
  if (!valid.length) { if (_zhipuData) { _showZhipu = true; renderUsageBar(); } return; }
  const acc = valid[_usageIndex % valid.length];
  const fh = acc.five_hour?.utilization ?? null;
  const sd = acc.seven_day?.utilization ?? null;
  if (fh === null && sd === null) return;
  el.innerHTML = (fh != null ? usageChip(fh, acc.five_hour?.resets_at, '5h') : '') +
    (sd != null ? usageChip(sd, acc.seven_day?.resets_at, '7d') : '');
  el.style.cursor = 'pointer';
  el.title = '点击切换 CC / 智谱';
}

export async function fetchUsage() {
  const data = await getUsage();
  if (data && !data.error) {
    _usageAccounts = Array.isArray(data) ? data : [data];
    renderUsageBar();
  }
  const zhipu = await getZhipuUsage();
  if (zhipu && !zhipu.error) { _zhipuData = zhipu; if (_showZhipu) renderUsageBar(); }
}

document.addEventListener('click', (e) => {
  const bar = $('#usage-bar');
  if (!bar?.contains(e.target)) return;
  if (_showZhipu) { _showZhipu = false; }
  else {
    const valid = _usageAccounts.filter(a => a && !a.error);
    if (valid.length > 1 && _usageIndex < valid.length - 1) { _usageIndex = (_usageIndex + 1) % valid.length; }
    else if (_zhipuData) { _showZhipu = true; }
  }
  renderUsageBar();
});

// ─── 本机资源 ───

export async function fetchSysInfo() {
  const data = await getSysInfo();
  if (!data) return;
  const el = $('#sysinfo-bar');
  if (!el) return;
  function chip(pct, label) {
    const cls = pct >= 85 ? 'usage-danger' : pct >= 60 ? 'usage-warn' : 'usage-ok';
    return `<span class="usage-chip ${cls}" title="${label} ${pct}%"><span class="usage-period">${label}</span><span class="usage-pct">${pct}%</span></span>`;
  }
  el.innerHTML = chip(data.cpu, 'CPU') + chip(data.ram, 'RAM');
}

// ─── 远程机器状态 ───

const _machineOrder = ['small-server', 'huawei', 'big-server', 'luoyang7772', 'luoyang7726', 'kangjia-yun'];

function _remoteMachines(machines) {
  return machines.filter(m => m.id !== 'local').sort((a, b) => {
    const ai = _machineOrder.indexOf(a.id), bi = _machineOrder.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function _matchMcDevice(m, mcDevices) {
  if (!m.alias) return null;
  const matches = mcDevices.filter(d => d.name && d.name.startsWith(m.alias));
  return matches.find(d => d.online) || matches[0] || null;
}

export function renderMachinesBtn(machines) {
  const bar = $('#machines-bar');
  if (!bar) return;
  const remote = _remoteMachines(machines);
  const online = remote.filter(m => m.status === 'online').length;
  bar.innerHTML = `<button class="btn-machines" title="${online}/${remote.length} 台在线">算</button>`;
}

export function renderMachinesGrid(machines, mcDevices = []) {
  const grid = $('#machines-grid');
  if (!grid) return;
  const remote = _remoteMachines(machines);
  if (!remote.length) { grid.innerHTML = ''; return; }
  grid.innerHTML = remote.map(m => {
    const st = m.status === 'online' ? 'online' : m.status === 'offline' ? 'offline' : 'unknown';
    const mcDev = _matchMcDevice(m, mcDevices);
    const agentSt = mcDev ? (mcDev.online ? 'online' : 'offline') : 'none';
    const agentDot = agentSt === 'online'
      ? `<span class="mc-agent-dot" style="background:#22c55e" title="点击接管"></span>`
      : agentSt === 'offline'
        ? `<span class="mc-agent-dot" style="background:#f97316" title="agent 离线"></span>`
        : `<span class="mc-agent-dot" style="background:#9ca3af" title="未部署接管 agent"></span>`;
    const takeoverClass = agentSt === 'online' ? ' mc-takeover-ready' : '';
    const mcNameAttr = mcDev ? ` data-mc-name="${mcDev.name.replace(/"/g, '&quot;')}"` : '';
    const cursorStyle = agentSt === 'online' ? 'cursor:pointer;' : '';
    let body;
    if (st !== 'online') {
      body = `<div class="mc-offline-text">${st === 'offline' ? '离线' : '未知'}</div>`;
    } else {
      const cpuVal = m._live?.cpu_pct != null ? Math.round(parseFloat(m._live.cpu_pct)) : m.cpu;
      body = `<div class="mc-row"><span class="mc-label">CPU</span><span class="mc-val">${cpuVal}%</span></div>` +
        `<div class="mc-row"><span class="mc-label">RAM</span><span class="mc-val">${m.ram}%</span></div>`;
      if (m._live) {
        const gpuStr = _fmtGpu(m._live.gpu);
        if (gpuStr) body += `<div class="mc-row"><span class="mc-label">GPU</span><span class="mc-val">${gpuStr}</span></div>`;
        const net = m._live.net || {};
        body += `<div class="mc-row"><span class="mc-label">国内</span><span class="mc-val">${_fmtBps(net.cn_bps)}</span></div>`;
        body += `<div class="mc-row"><span class="mc-label">国际</span><span class="mc-val">${_fmtBps(net.intl_bps)}</span></div>`;
        body += `<div class="mc-row"><span class="mc-label">GH</span><span class="mc-val">${_fmtBps(net.gh_raw_bps)}</span></div>`;
      }
      if (m.disk) {
        for (const d of m.disk.split(',')) {
          const mm = d.match(/^([A-Z]:|\/[A-Za-z]*)(\d+)%$/);
          if (mm) body += `<div class="mc-row"><span class="mc-label">${mm[1]}</span><span class="mc-val">${mm[2]}%</span></div>`;
        }
      }
      if (m.uptime) body += `<div class="mc-row"><span class="mc-label">运行</span><span class="mc-val">${m.uptime}</span></div>`;
    }
    return `<div class="machine-card ${st}${takeoverClass}" style="${cursorStyle}"${mcNameAttr}><div class="mc-header"><span class="mc-dot ${st}"></span><span class="mc-name">${m.name}</span>${agentDot}</div>${body}</div>`;
  }).join('');
}

function _fmtBps(v) {
  if (v === 'skipped' || v === 'hourly' || v == null) return '-';
  const n = typeof v === 'number' ? v : parseInt(v);
  if (!n || isNaN(n)) return '-';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M';
  if (n >= 1024) return (n / 1024).toFixed(0) + 'K';
  return n + '';
}

function _fmtGpu(g) {
  if (!g || g === 'no-gpu') return null;
  const m = g.match(/util=(\d+)%\s+vram=(\d+)\/(\d+)MB/);
  if (m) return `${m[1]}% ${(m[2]/1024).toFixed(1)}/${(m[3]/1024).toFixed(0)}G`;
  return '-';
}

function _mergeLive(machines, liveList) {
  if (!liveList || !Array.isArray(liveList)) return machines;
  const byHost = new Map();
  for (const m of liveList) byHost.set(m.host, m);
  return machines.map(m => {
    if (!m.alias) return m;
    let live = null;
    for (const [host, data] of byHost) {
      if (host && (host.startsWith(m.alias) || host.includes(m.alias))) { live = data; break; }
    }
    return live ? { ...m, _live: live } : m;
  });
}

export async function fetchMachines() {
  const { base, live, mcDevices } = await getMachines();
  if (!base) return;
  const liveList = live?.machines || [];
  const merged = _mergeLive(base, liveList);
  state._machinesCache = merged;
  renderMachinesBtn(merged);
  renderMachinesGrid(merged, mcDevices);
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('.machine-card.mc-takeover-ready');
  if (!card) return;
  const mcName = card.dataset.mcName;
  if (!mcName) return;
  card.style.opacity = '0.6'; card.style.pointerEvents = 'none';
  fetch(BASE_PATH + '/api/takeover/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine: mcName, expire_minutes: 60, reason: '算力卡片接管', conflict_policy: 'force' }),
  }).then(r => r.json()).then(data => {
    if (!data.token) throw new Error(data.error || '未知错误');
    window.location.href = `${BASE_PATH}/takeover/${encodeURIComponent(data.token)}`;
  }).catch(err => {
    card.style.opacity = ''; card.style.pointerEvents = '';
    alert('接管失败：' + err.message);
  });
});
