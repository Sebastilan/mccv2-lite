// index.mjs — /api/sources* HTTP 路由（主板）+ provider 注册表 + 合并 list
//
// SourceProvider 接缝：owns(id) / list({project,context}) / tree(id,rel) / file(id,rel)
//                      / fetch(id,rel) → {name,mimeType,size,base64} / share(id,body) → {code,data}
// 加新源 = 往 PROVIDERS 注册一行；

import { json, readBody } from '../_helpers.mjs';
import { localProvider } from './provider-local.mjs';

const PROVIDERS = [localProvider];
const providerFor = (id) => PROVIDERS.find(p => p.owns(id));

export function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (!path.startsWith('/api/sources')) return false;

  // GET /api/sources?project=&context=  → 合并所有 provider 的 list（按 context 过滤）
  if (req.method === 'GET' && path === '/api/sources') {
    const project = url.searchParams.get('project');
    const context = url.searchParams.get('context') || 'browse';
    const out = [];
    for (const p of PROVIDERS) {
      try { out.push(...(p.list({ project, context }) || [])); }
      catch (e) { console.warn('[sources] list error:', e.message); }
    }
    json(res, out);
    return true;
  }

  // GET /api/sources/:id/{tree|file|fetch}  |  POST /api/sources/:id/share
  const m = path.match(/^\/api\/sources\/([^/]+)\/(tree|file|fetch|share)$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const op = m[2];
  const provider = providerFor(id);
  if (!provider) { json(res, { error: 'unknown source' }, 404); return true; }

  if (op === 'share') {
    if (req.method !== 'POST') return false;
    readBody(req).then(raw => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const r = provider.share(id, body);   // { code, data }
      json(res, r.data, r.code || 200);
    }).catch(e => {
      console.error('[sources] share error:', e.message);
      json(res, { error: e.message }, 400);
    });
    return true;
  }

  if (req.method !== 'GET') return false;
  const rel = url.searchParams.get('path') || '';
  Promise.resolve()
    .then(() => provider[op](id, rel))
    .then(r => json(res, r))
    .catch(e => {
      console.warn(`[sources] ${op} error:`, e.message);
      json(res, { error: e.message });
    });
  return true;
}
