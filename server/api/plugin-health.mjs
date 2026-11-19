// plugin-health.mjs — POST/GET /api/plugins/health（委托给 service-health）
import { json, readBody } from './_helpers.mjs';
import { getSnapshot, setPluginsFromFrontend } from '../ops/service-health.mjs';

export function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/plugins/health') return false;

  if (req.method === 'GET') {
    json(res, getSnapshot());
    return true;
  }

  if (req.method === 'POST') {
    readBody(req).then(raw => {
      let body;
      try { body = JSON.parse(raw); } catch { json(res, { error: 'invalid json' }, 400); return; }
      // canvas 发全量 snapshot {aggregate, plugins, ts}；兼容旧格式和新格式
      setPluginsFromFrontend(body.plugins !== undefined ? body.plugins : body);
      json(res, { ok: true });
    }).catch(e => {
      console.error('[plugin-health] POST failed:', e.message);
      json(res, { error: e.message }, 500);
    });
    return true;
  }

  return false;
}
