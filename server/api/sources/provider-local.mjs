// provider-local.mjs — 本地 fs 源（工作区下各项目）
//
// 抽象 Source：{ id, label, kind }
//   - project:<name>  → <MCC_WORKSPACE>/<name>
// context==='browse'（项目地图，默认）才贡献 list；'attach'（"+"选择器）不出本地源。

import { readdirSync, statSync, readFileSync } from 'fs';
import { resolve, join, sep } from 'path';
import { register as registerShare } from '../../review/share.mjs';
import { WORKSPACE_ROOT } from '../../ops/config.mjs';

const CCA_ROOT      = WORKSPACE_ROOT;
const SKIP          = new Set(['node_modules', '.git']);
const TEXT_EXT      = new Set(['js','mjs','ts','tsx','jsx','json','md','html','css','py','sh','yml','yaml','toml','xml','svg','txt','log','env','sql','rs','go','java','c','cc','cpp','h','hpp','rb','lua','toml','ini','conf']);
const MAX_FILE_SIZE = 2 * 1024 * 1024;  // 2MB
const MAX_FETCH     = 5 * 1024 * 1024;  // 5MB（fetch 成附件上限）

function _resolveRoot(id) {
  if (id?.startsWith('project:')) {
    const name = id.slice(8);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    const root = join(CCA_ROOT, name);
    try { if (statSync(root).isDirectory()) return root; } catch {}
  }
  return null;
}

function _safePath(root, rel) {
  const abs = resolve(root, rel || '');
  if (!abs.startsWith(root + sep) && abs !== root) return null;
  return abs;
}

function _readTree(root, rel) {
  const abs = _safePath(root, rel);
  if (!abs) return { error: 'invalid path' };
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); }
  catch (err) { return { error: err.message }; }
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    if (SKIP.has(e.name)) continue;
    items.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
  }
  items.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return { entries: items };
}

function _readFile(root, rel) {
  const abs = _safePath(root, rel);
  if (!abs) return { error: 'invalid path' };
  let st;
  try { st = statSync(abs); } catch { return { error: 'not found' }; }
  if (st.isDirectory()) return { error: 'is directory' };
  if (st.size > MAX_FILE_SIZE) return { error: 'file too large', size: st.size };
  const ext = abs.split('.').pop().toLowerCase();
  const isText = TEXT_EXT.has(ext) || st.size < 64 * 1024;
  if (!isText) return { error: 'binary', size: st.size, ext };
  try {
    const content = readFileSync(abs, 'utf-8');
    return { content, size: st.size, ext };
  } catch (err) { return { error: err.message }; }
}

function _fetch(root, rel) {
  const abs = _safePath(root, rel);
  if (!abs) return { error: 'invalid path' };
  let st;
  try { st = statSync(abs); } catch { return { error: 'not found' }; }
  if (st.isDirectory()) return { error: 'is directory' };
  if (st.size > MAX_FETCH) return { error: 'file too large', size: st.size };
  const name = abs.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  try {
    const base64 = readFileSync(abs).toString('base64');
    return { name, mimeType: mimeOf(ext), size: st.size, base64 };
  } catch (err) { return { error: err.message }; }
}

function mimeOf(ext) {
  const M = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
    pdf:'application/pdf', txt:'text/plain', md:'text/markdown', json:'application/json',
    csv:'text/csv', zip:'application/zip' };
  return M[ext] || 'application/octet-stream';
}

export const localProvider = {
  owns(id) { return typeof id === 'string' && id.startsWith('project:'); },

  list({ project, context } = {}) {
    if (context === 'attach') return [];   // 本地源只服务项目地图浏览，不进"+"附件选择器
    const out = [];
    if (project && /^[a-zA-Z0-9_-]+$/.test(project)) {
      const root = join(CCA_ROOT, project);
      try { if (statSync(root).isDirectory()) out.push({ id: `project:${project}`, label: project, kind: 'project' }); } catch {}
    }
    return out;
  },

  tree(id, rel) {
    const root = _resolveRoot(id);
    if (!root) return { error: 'unknown source' };
    return _readTree(root, rel);
  },

  file(id, rel) {
    const root = _resolveRoot(id);
    if (!root) return { error: 'unknown source' };
    return _readFile(root, rel);
  },

  fetch(id, rel) {
    const root = _resolveRoot(id);
    if (!root) return { error: 'unknown source' };
    return _fetch(root, rel);
  },

  // POST /share：注册 review token（保持旧响应体与状态码）
  share(id, { path: rel, from_actor, ttl_seconds } = {}) {
    const root = _resolveRoot(id);
    if (!root) return { code: 404, data: { error: 'unknown source' } };
    const abs = _safePath(root, rel);
    if (!abs) {
      console.warn('[sources] share rejected: invalid path', { id, rel });
      return { code: 400, data: { error: 'invalid path' } };
    }
    const payload = registerShare(abs, from_actor ?? null, ttl_seconds);
    if (!payload) {
      console.warn('[sources] share rejected by share.register', { abs, from_actor });
      return { code: 400, data: { error: 'path-rejected' } };
    }
    return { code: 201, data: { ...payload, url: `/review.html?token=${payload.token}` } };
  },
};
