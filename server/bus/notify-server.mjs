// notify-server.mjs — Unix socket 通知端点（外部 notify + cc-pool 双向通信）
import net from 'net';
import fs from 'fs';
import { obs } from '../ops/observability.mjs';

/**
 * opts.onPoolConnected(conn, kind) — called when a pool sends register_pool.
 * Core keeps the conn alive and uses it to push new_message / new_actor events.
 * kind is from msg.kind in register_pool payload (e.g. 'cc', 'ling').
 */
export function startNotifyServer(socketPath, bus, broadcaster, opts = {}) {
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((conn) => {
    let buf = '';
    let isPool = false;

    conn.on('data', (data) => {
      buf += data.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        const msg = JSON.parse(line);

        if (msg.event === 'register_pool') {
          // A pool is registering — keep connection, hand to registry with kind
          isPool = true;
          opts.onPoolConnected?.(conn, msg.kind || 'cc');
          // No response: this is a long-lived control connection

        } else if (msg.event === 'actor_gone') {
          // cc-pool reports a CC child crashed
          if (msg.actorId) {
            bus.updateActor(msg.actorId, { status: 'gone', last_seen: Date.now() });
            bus.emit('actor_status', { actorId: msg.actorId, status: 'gone' });
          }

        } else if (msg.event === 'new_message' && isPool) {
          // cc-pool wrote a reply to DB — trigger broadcast
          obs.counter('pool.notify');
          broadcaster.pollMissed();

        } else if (msg.event === 'pool_trace' && isPool) {
          // cc-pool forwards stderr / crash events → visible in /api/traces
          const { event: _ev, ...traceData } = msg;
          obs.recordTrace(traceData);

        } else if (msg.event === 'pool_counter' && isPool) {
          // cc-pool forwards counter increments
          obs.counter(msg.name, msg.n || 1);

        } else if (msg.event === 'actor_status' && isPool) {
          // cc-pool reports actor busy/idle — push update to all WS clients
          if (msg.actorId) {
            const row = bus.db.prepare('SELECT * FROM actors WHERE id=?').get(msg.actorId);
            if (row) broadcaster.broadcastActorUpdate(row);
            bus.emit('actor_status', { actorId: msg.actorId, status: msg.status });
          }

        } else if (msg.event === 'actor_updated') {
          // 任何本地 service 都可触发重广播（cc-pool 改 sessionModel / summarizer 改 recentSummary 等）
          if (msg.actorId) {
            const row = bus.db.prepare('SELECT * FROM actors WHERE id=?').get(msg.actorId);
            if (row) broadcaster.broadcastActorUpdate(row);
          }

        } else if (msg.event === 'stream_delta' && isPool) {
          // cc-pool 推思考流式增量 —— 瞬时广播给订阅方，不落库（完整块仍走 new_message）
          broadcaster.broadcastStreamDelta(msg);

        } else {
          // Legacy / external tool notify: pollMissed + ack
          obs.counter('notify.received');
          broadcaster.pollMissed();
          conn.write(JSON.stringify({ ok: true }) + '\n');
        }
      }
    });

    conn.on('error', (err) => console.error('[notify] conn error:', err.message));
  });

  server.listen(socketPath, () => {
    console.log(`[notify] Unix socket listening at ${socketPath}`);
  });

  return server;
}
