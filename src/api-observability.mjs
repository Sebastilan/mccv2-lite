// api-observability.mjs — GET /api/health, /api/metrics, /api/traces, /api/slow
import { obs } from './observability.mjs';

/**
 * ctx: { bus, broadcaster, poolSupervisor }
 * Returns false if route not matched (caller continues to next handler).
 */
export function handleObsApi(req, res, ctx = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') {
    const t = Date.now();
    let dbOk = false;
    try {
      if (ctx.bus) { ctx.bus.db.prepare('SELECT 1').get(); dbOk = true; }
    } catch {}
    const deps = {
      db: dbOk,
      broadcaster: !!ctx.broadcaster,
      ccpool_alive: !!ctx.poolSupervisor?.pools?.get('cc')?.isAlive(),  // 多 pool 重构后 poolConn 已废弃，改读 registry 的 cc pool 存活
    };
    const health = obs.getHealth(deps);
    const ms = Date.now() - t;
    obs.hist('health.ms', ms);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Server-Timing': `uptime;dur=${health.uptime_seconds * 1000}`,
    });
    res.end(JSON.stringify(health));
    return true;
  }

  if (url.pathname === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obs.getMetrics()));
    return true;
  }

  if (url.pathname === '/api/traces') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obs.getTraces(limit)));
    return true;
  }

  if (url.pathname === '/api/slow') {
    const threshold = parseInt(url.searchParams.get('threshold') || '100');
    const metrics = obs.getMetrics();
    const slow = {};
    for (const [name, h] of Object.entries(metrics.histograms)) {
      if (h.p99 > threshold) slow[name] = h;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ threshold_ms: threshold, slow }));
    return true;
  }

  return false;
}
