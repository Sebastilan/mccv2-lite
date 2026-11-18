// broadcast.mjs — WebSocket 广播器（insertMessage 直推 + 500ms polling 兜底 + cc-pool 通知）
import { WebSocket } from 'ws';
import { obs } from './observability.mjs';

export class Broadcaster {
  constructor(bus) {
    this.bus = bus;
    this.wsMap = new Map();      // actorId -> Set<ws>（多标签页同 actorId 共存）
    this.reverseMap = new Map(); // ws -> actorId
    this.lastBroadcastId = bus.getMaxMessageId();
    this.poolSupervisor = null;  // set after construction
  }

  /** Set after PoolSupervisor is created (avoids circular dep at construction). */
  setPoolSupervisor(ps) {
    this.poolSupervisor = ps;
  }

  addWS(actorId, ws) {
    let set = this.wsMap.get(actorId);
    if (!set) { set = new Set(); this.wsMap.set(actorId, set); }
    set.add(ws);
    this.reverseMap.set(ws, actorId);
  }

  removeWS(ws) {
    const actorId = this.reverseMap.get(ws);
    if (!actorId) return;
    this.reverseMap.delete(ws);
    const set = this.wsMap.get(actorId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.wsMap.delete(actorId);
  }

  onMessage(msg) {
    // msg 已落库。不能直接 _dispatch(msg) 后把 lastBroadcastId 跳到 msg.id：
    // cc-pool 是独立进程，可能刚写了 id<msg.id 的回复还没被 pollMissed 推出去，
    // 跳号会让那批消息被永久跳过（getNewMessagesSince 再也捞不到）→ 只能靠刷新从 DB 读到。
    // 统一走 pollMissed：按 id 升序补齐 (lastBroadcastId, max] 全区间（含 msg 自身），杜绝跨进程竞态空洞。
    this.pollMissed();
  }

  _dispatch(msg) {
    const t = Date.now();
    obs.counter('broadcast.sent');
    const envelope = JSON.stringify({ type: 'message', message: msg });
    const sent = new Set();
    const sendOne = (ws) => {
      if (sent.has(ws) || ws.readyState !== WebSocket.OPEN) return;
      // 作用域访客 ws 只收「与它那个 actor 相关」的消息（收发任一端命中）——挡住全站火筒泄漏。
      if (ws._scopedActor && ws._scopedActor !== msg.from_id && ws._scopedActor !== msg.to_id) return;
      ws.send(envelope);
      sent.add(ws);
    };

    // Deliver to direct WS recipient(s) (wrapped per ws-protocol.md)
    for (const ws of this.wsMap.get(msg.to_id) || []) sendOne(ws);

    // A2: 把 human 自己发出的消息回推给他自己的 ws，提供服务端确认副本。
    // 此前 human 的 user_msg（to_id=cc）只投递给 cc 侧，发送方浏览器纯靠乐观本地插入；
    // POST 慢或期间一次重连触发 rebuild（从 messagesByActor 重建、不含未确认的乐观条目）
    // 就会把"自己发的消息"抹掉。回推后前端可把它落进 messagesByActor，重建无损。
    // cc/worker 无浏览器 ws，wsMap.get(from_id) 只会命中 human_self 等真实前端连接；
    // `sent` 去重确保某 ws 既是收件端又是发件端时不重复发。
    for (const ws of this.wsMap.get(msg.from_id) || []) sendOne(ws);

    // Notify pool registry — routes to the right pool by actor.kind（人类等 no-op）
    if (msg.to_id && this.poolSupervisor) {
      this.poolSupervisor.notifyNewMessage(msg.to_id);
    }

    // Deliver to subscribers (dedup vs direct via `sent`)
    for (const watcherId of this.bus.listSubs(msg.to_id)) {
      for (const ws of this.wsMap.get(watcherId) || []) sendOne(ws);
    }
    obs.hist('broadcast.ms', Date.now() - t);
  }

  broadcastAll(data) {
    const payload = JSON.stringify(data);
    // 作用域访客只应看到「自己那个 actor」的 update/gone，不泄漏全站终端清单/元信息。
    const involved = data.type === 'actor_update' ? data.actor?.id
                   : data.type === 'actor_gone'   ? data.actorId
                   : null;
    for (const set of this.wsMap.values()) {
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws._scopedActor && involved && ws._scopedActor !== involved) continue;
        ws.send(payload);
      }
    }
  }

  // 思考流式增量：瞬时推给关注该 actor 的 ws（直连 toId + 订阅者），不落库、不动 lastBroadcastId。
  // 路由同 _dispatch（按 toId + subs），避免把某 actor 的思考广播给无关页面。
  broadcastStreamDelta({ actorId, toId, subtype, text }) {
    if (!toId || !text) return;
    const envelope = JSON.stringify({ type: 'stream_delta', actorId, subtype: subtype || 'thinking', text });
    const sent = new Set();
    const sendOne = (ws) => {
      if (sent.has(ws) || ws.readyState !== WebSocket.OPEN) return;
      // 思考流式增量按其归属 actorId 过滤：作用域访客只看自己那个 actor 的思考。
      if (ws._scopedActor && ws._scopedActor !== actorId) return;
      ws.send(envelope);
      sent.add(ws);
    };
    for (const ws of this.wsMap.get(toId) || []) sendOne(ws);
    for (const watcherId of this.bus.listSubs(toId)) {
      for (const ws of this.wsMap.get(watcherId) || []) sendOne(ws);
    }
  }

  broadcastActorUpdate(actor) {
    this.broadcastAll({ type: 'actor_update', actor });
  }

  broadcastActorGone(actorId) {
    this.broadcastAll({ type: 'actor_gone', actorId });
  }

  pollMissed() {
    const newMsgs = this.bus.getNewMessagesSince(this.lastBroadcastId);
    for (const msg of newMsgs) {
      this.lastBroadcastId = msg.id;
      this._dispatch(msg);
    }
  }
}
