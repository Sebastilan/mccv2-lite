// actor-bus/api.mjs — actor-to-actor 通讯基建的 HTTP 入口（两端点）
// /api/actor-bus/send  + /api/actor-bus/messages
// 权限全开：由 cc-pool 注入 MCC_ACTOR_ID env 担保身份；MCP server actor 是主要调用方
// （前端 @ mention 走 /api/messages，不走这里——这里是 actor↔actor 不带前端的纯后端面）
import { obs } from '../ops/observability.mjs';

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function handleActorBusApi(req, res, bus) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // POST /api/actor-bus/send — { from_id, to_id, text }
  if (req.method === 'POST' && p === '/api/actor-bus/send') {
    parseBody(req).then(({ from_id, to_id, text }) => {
      if (!from_id || !to_id || typeof text !== 'string') {
        obs.counter('actor_bus.send.error');
        return json(res, 400, { error: 'from_id, to_id, text required' });
      }
      const target = bus.db.prepare("SELECT id FROM actors WHERE id=? AND status!='gone'").get(to_id);
      if (!target) {
        obs.counter('actor_bus.send.error');
        return json(res, 404, { error: 'target actor not found or gone' });
      }
      // expectAutoReply=false：actor-bus 是"信件"，对方收到后不预设自动回信路由
      // → cc-pool 不会把 lastFrom 设成发件人，避免 actor↔actor 死循环
      // （要回信必须显式调 send_message。详见 docs/actor-bus.md §"信件 vs 会话流"）
      const msg = bus.insertMessage({
        from_id, to_id, kind: 'user_msg',
        payload: { text, meta: { expectAutoReply: false } }, ts: Date.now(),
      });
      obs.counter('actor_bus.send.ok');
      json(res, 201, { id: msg.id });
    }).catch(() => {
      obs.counter('actor_bus.send.error');
      json(res, 400, { error: 'invalid JSON' });
    });
    return true;
  }

  // GET /api/actor-bus/messages?actor=<id>&limit=N — 双向纯文本历史
  if (req.method === 'GET' && p === '/api/actor-bus/messages') {
    const actorId = url.searchParams.get('actor');
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), 200);
    if (!actorId) {
      obs.counter('actor_bus.read.error');
      json(res, 400, { error: 'actor required' });
      return true;
    }
    const rows = bus.db.prepare(
      "SELECT id, from_id, to_id, kind, payload, ts FROM messages " +
      "WHERE (to_id=? OR from_id=?) AND kind IN ('user_msg','text') " +
      "ORDER BY id DESC LIMIT ?"
    ).all(actorId, actorId, limit);
    const msgs = rows.reverse().map(r => {
      let pl = {}; try { pl = JSON.parse(r.payload); } catch {}
      return {
        id: r.id, ts: r.ts, from_id: r.from_id, to_id: r.to_id,
        text: typeof pl.text === 'string' ? pl.text : '',
      };
    });
    obs.counter('actor_bus.read.ok');
    json(res, 200, { actor: actorId, messages: msgs });
    return true;
  }

  return false;
}
