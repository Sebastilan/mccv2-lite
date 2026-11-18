// api.js — HTTP 调用封装（所有插件经此统一，纯 throw，toast 策略由调用方决定）

import { BASE_PATH } from './state.js';

export async function apiFetch(url, options = {}) {
  const res = await fetch(BASE_PATH + url, { credentials: 'include', ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
}


// ─── actors ───

export async function listActors() {
  return apiFetch('/api/actors').then(r => r.json());
}

export async function getActor(id) {
  return apiFetch(`/api/actors/${id}`).then(r => r.json());
}

export async function createActor(params) {
  return apiFetch('/api/actors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }).then(r => r.json());
}

export async function deleteActor(id) {
  return apiFetch(`/api/actors/${id}`, { method: 'DELETE' }).then(r => r.json());
}

// opts: { since } 增量补差 / { before, limit } 上滑加载更早 / { limit } 首屏最近一页
export async function getActorMessages(id, opts = {}) {
  const p = new URLSearchParams();
  if (opts.since != null)  p.set('since', opts.since);
  if (opts.before != null) p.set('before', opts.before);
  if (opts.limit != null)  p.set('limit', opts.limit);
  const qs = p.toString() ? `?${p}` : '';
  return apiFetch(`/api/actors/${id}/messages${qs}`).then(r => r.json());
}

export async function patchActorMeta(id, meta) {
  return apiFetch(`/api/actors/${id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  }).then(r => r.json());
}

export async function patchActorAdvisorType(id, advisorType) {
  return apiFetch(`/api/actors/${id}/advisor-type`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ advisorType }),
  }).then(r => r.json());
}

export async function patchActorLock(id, locked) {
  return apiFetch(`/api/actors/${id}/lock`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked }),
  }).then(r => r.json());
}

export async function patchActorName(id, name) {
  return apiFetch(`/api/actors/${id}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json());
}


// ─── share links（终端分享链接：窄锁凭证，本人生成/停用）───

// 列某终端当前有效分享链接 → { actorId, links: [{token, actorId, createdAt}] }
export async function getShareLinks(id) {
  return apiFetch(`/api/actors/${id}/share`).then(r => r.json());
}

// 生成一条新分享链接 → { token, actorId, path }（path 形如 /s/<token>）
export async function createShareLink(id) {
  return apiFetch(`/api/actors/${id}/share`, { method: 'POST' }).then(r => r.json());
}

// 停用该终端全部分享链接 → { ok, revoked }
export async function revokeShareLinks(id) {
  return apiFetch(`/api/actors/${id}/share`, { method: 'DELETE' }).then(r => r.json());
}

// 当前会话作用域 → { scoped: bool, actorId }（scoped=true 即分享链接访客）
export async function getScope() {
  return apiFetch('/api/scope').then(r => r.json());
}

// ─── messages ───

export async function sendMessage(toId, kind, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_id: toId, kind, payload }),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function sendControl(toId, command, params = {}) {
  return sendMessage(toId, 'control', { command, ...params });
}

// ─── pin slots（顶置占位声明）───

export async function listPinSlots() {
  return apiFetch('/api/pin-slots').then(r => r.ok ? r.json() : []);
}

// ─── projects (create modal) ───

export async function listProjects() {
  return apiFetch('/api/projects').then(r => r.json());
}

// ─── asr（语音转写）───

// audio: base64 编好的 16k 单声道 WAV；返回 { text }
export async function recognizeSpeech(audio, { format = 'wav', engine = '16k_zh' } = {}) {
  return apiFetch('/api/asr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, format, engine }),
  }).then(r => r.json());
}

// ─── provider ───

export async function getProvider() {
  return apiFetch('/api/provider').then(r => r.json());
}

// ─── skills ───

export async function listSkills() {
  return apiFetch('/api/skills').then(r => r.json());
}

export async function getSkill(name) {
  return apiFetch(`/api/skills/${encodeURIComponent(name)}`).then(r => r.text());
}

// ─── usage ───

export async function getUsage() {
  return apiFetch('/api/usage').then(r => r.json());
}

export async function getZhipuUsage() {
  return apiFetch('/api/usage/zhipu').then(r => r.json());
}

export async function getSysInfo() {
  return apiFetch('/api/sysinfo').then(r => r.json());
}

export async function getMachines() {
  const [base, live, mcDevices] = await Promise.all([
    apiFetch('/api/machines').then(r => r.json()),
    apiFetch('/api/machines/list').then(r => r.json()),
    apiFetch('/api/takeover/machines').then(r => r.json()),
  ]);
  return { base, live, mcDevices: mcDevices?.devices || [] };
}

// ─── history ───

export async function getHistory() {
  return apiFetch('/api/history').then(r => r.json());
}

export async function searchHistory(q) {
  return apiFetch('/api/history/search?q=' + encodeURIComponent(q)).then(r => r.json());
}

export async function getHistoryDetail(sessionId) {
  return apiFetch(`/api/history/${sessionId}`).then(r => r.json());
}

export async function getHistoryConversation(fileId) {
  return apiFetch(`/api/history/conversation?fileId=${encodeURIComponent(fileId)}`).then(r => r.json());
}

export async function resumeSession(sessionId, model) {
  const body = model ? JSON.stringify({ model }) : '{}';
  return apiFetch(`/api/history/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(r => r.json());
}

// ─── restart ───

export function restartServer() {
  return apiFetch('/api/restart', { method: 'POST' });
}
