// human.mjs — HumanAdapter（浏览器 WebSocket → Actor 消息双向桥接）
import { AdapterBase } from '../_base/adapter-base.mjs';
import { WebSocket } from 'ws';

export class HumanAdapter extends AdapterBase {
  constructor(actorId, meta, bus) {
    super(actorId, meta, bus);
    this.ws = null;
  }

  async start() {
    this.bus.registerActor(this.actorId, 'human', this.meta);
    this.markStatus('idle');
  }

  bindWebSocket(ws) {
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(1008, 'invalid JSON'); return; }
      switch (msg.type) {
        case 'ping':
          // 立即回 pong：客户端据此判定 socket 是否「半死」（见 core/ws.js 活动检测）
          ws.isAlive = true;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default: console.warn(`[human] unknown ws type: ${msg.type}`);
      }
    });
    ws.on('close', () => {
      // A3: human_self 是跨标签共享的单例 adapter。多标签下每个 ws 都注册了自己的 close，
      // 若无条件 this.ws=null + markStatus('gone')，关任意一个旧标签就会把当前标签的绑定清掉、
      // 并把整个 human actor 误判为 gone（多标签互踩）。只在关的正是当前绑定的 ws 时才动手。
      if (this.ws !== ws) return;
      this.ws = null;
      this.markStatus('gone');
    });
  }

  async deliver(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.markStatus('gone');
  }
}
