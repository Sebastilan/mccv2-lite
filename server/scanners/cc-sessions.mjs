// cc-sessions.mjs — 扫 ~/.claude/projects/*.jsonl，列 / 详 / 取消息（CC 原生会话）
//
// 每个 jsonl 文件对应一个 CC 会话；第一条 type:"user" 消息含 cwd / sessionId / message.content。
// 列表带 30s 缓存；只返回近 7 天有活动的会话。

import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stripInjection } from './inject-markers.mjs';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_LINES = 20;
const CACHE_TTL_MS = 30_000;

let _cache = null;
let _cacheAt = 0;

export function listSessions() {
  return _ensureCache().map(({ _filePath: _, ...s }) => s);
}

export function getSession(sessionId) {
  return _ensureCache().find(s => s.sessionId === sessionId) || _findById(sessionId);
}

export function getSessionMessages(sessionId) {
  const session = _ensureCache().find(s => s.sessionId === sessionId) || _findById(sessionId);
  if (!session?._filePath) return [];
  let lines;
  try { lines = readFileSync(session._filePath, 'utf-8').split('\n'); } catch { return []; }
  const msgs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message?.role === 'user') {
        const c = obj.message.content;
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : '';
        // 剥掉平台注入块（记忆库地图 / 常驻基因 / 决策摘要 / 携带快照 / process.md / gitStatus 等），
        // 历史抽屉只显示真实用户消息本身。剥完为空则跳过（纯注入轮不成条）。
        const clean = stripInjection(text);
        if (clean.trim()) msgs.push({ role: 'user', text: clean });
      } else if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const blocks = obj.message.content || [];
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text.trim()) msgs.push({ role: 'assistant', text });
      }
    } catch { /* skip bad line */ }
  }
  return msgs;
}

export function invalidate() { _cache = null; _cacheAt = 0; }

function _ensureCache() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  _cache = _scan();
  _cacheAt = Date.now();
  return _cache;
}

function _findById(sessionId) {
  const fname = sessionId + '.jsonl';
  let entries;
  try { entries = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return null; }
  for (const dir of entries) {
    const filePath = join(PROJECTS_DIR, dir.name, fname);
    try {
      const stat = statSync(filePath);
      return _readMeta(filePath, sessionId, stat.mtimeMs);
    } catch { continue; }
  }
  return null;
}

function _scan() {
  const cutoff = Date.now() - MAX_AGE_MS;
  const sessions = [];
  let entries;
  try { entries = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return []; }
  for (const dir of entries) {
    const dirPath = join(PROJECTS_DIR, dir.name);
    let files;
    try { files = readdirSync(dirPath).filter(f => /^[0-9a-f-]{36}\.jsonl$/.test(f)); } catch { continue; }
    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) continue;
        const fallbackId = file.slice(0, -6);
        const meta = _readMeta(filePath, fallbackId, stat.mtimeMs);
        if (meta) sessions.push(meta);
      } catch { continue; }
    }
  }
  return sessions.sort((a, b) => b.ts - a.ts);
}

function _readMeta(filePath, fallbackId, ts) {
  let lines;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const CHUNK = 256 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let text = '';
      while (true) {
        const n = readSync(fd, buf, 0, CHUNK);
        if (n === 0) break;
        text += buf.toString('utf-8', 0, n);
        const parts = text.split('\n');
        if (parts.length > MAX_SCAN_LINES || n < CHUNK) break;
      }
      lines = text.split('\n', MAX_SCAN_LINES);
    } finally { closeSync(fd); }
  } catch { return null; }
  let meta = null;
  let model = '';                       // 该 session 原本使用的 model（取首条 assistant.message.model）
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (!model && obj.type === 'assistant' && obj.message?.model) model = obj.message.model;
      if (meta) continue;               // meta 已取到，继续只为补 model
      if (obj.type !== 'user' || !obj.cwd || obj.message?.role !== 'user') continue;
      const content = obj.message.content;
      const rawText = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
      const cwd = obj.cwd;
      const project = cwd.split(/[/\\]/).pop() || cwd;
      // preview 用剥注入后的真实消息，避免整屏注入串（与详情显示一致）
      const preview = stripInjection(rawText).replace(/\s+/g, ' ').trim().slice(0, 120);
      meta = {
        sessionId: obj.sessionId || fallbackId,
        cwd, project, ts, preview,
        _filePath: filePath,
      };
    } catch { continue; }
  }
  if (meta && model) meta.model = model;
  return meta;
}
