// controls.mjs — kind='control' 消息分发（interrupt 出走带外；其余 idle gate）
//
// 设计：control 不进 deliverLoop 的串行队列锁——interrupt 必须在 busy 时立刻生效。
// 由 cc-pool 在 new_message 事件中先 drain 全部 control，再启动 deliverLoop。
//
// 6 个命令语义参照 v1 ws-handlers.mjs:
//   interrupt — 子进程在跑：写 control_request 帧；否则忽略
//   status    — 回一条系统文本（不与子进程交互）
//   cost      — 回一条系统文本
//   compact   — busy 拒；idle 把 "/compact" 当用户消息入队（走正常 deliver 路径）
//   clear     — busy 拒；idle 杀子进程 + 清 sessionId，下次 spawn 启新会话
//   model     — busy 拒；idle 改 meta.model + 重算 providerEnv + 杀子进程。
//               sessionId 保留：--print 每轮本就是新进程 + --resume，换模型只是换 env + --model，
//               历史 JSONL 原样重放给新 API——对话轮内无损切换（跨厂商 resume 已探针验证，
//               含 thinking 块不中毒；退役模型的中毒 guard 在 buildLaunch 侧独立生效）。

import { writeInterruptFrame } from './stdin.mjs';
import { resolveByModel, resolveContextWindow } from '../../providers/_registry.mjs';

/**
 * 处理一条 control 消息。
 * ctx = { actorId, entry, db, emitMsg, sendToCore }
 * fromId = 消息来源 actor（系统回复发回此处）
 * payload = { command, ...params }
 */
export function handleControl(ctx, fromId, payload) {
  const { actorId, entry, db, emitMsg, sendToCore } = ctx;
  const cmd = payload?.command;
  if (!cmd || !entry) return;

  const childAlive = entry.child && entry.child.exitCode === null && entry.child.signalCode === null;
  const isBusy = db.prepare("SELECT status FROM actors WHERE id=?").get(actorId)?.status === 'busy';

  switch (cmd) {
    case 'interrupt': {
      if (childAlive) {
        try { writeInterruptFrame(entry.child.stdin); } catch {}
      }
      return;
    }

    case 'status': {
      const row = db.prepare('SELECT meta, status FROM actors WHERE id=?').get(actorId) || {};
      const m = JSON.parse(row.meta || '{}');
      const model = m.sessionModel || m.model || '?';
      const cost = (m.totalCost || 0).toFixed(4);
      emitMsg(actorId, fromId, 'text', { text: `📊 ${row.status || 'unknown'} · ${model} · 累计 $${cost}` });
      return;
    }

    case 'cost': {
      const m = JSON.parse(db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId)?.meta || '{}');
      const cost = (m.totalCost || 0).toFixed(4);
      const ctxTok = m.lastUsage?.input_tokens ?? null;
      const ctxStr = ctxTok != null ? `${ctxTok} tok` : '—';
      emitMsg(actorId, fromId, 'text', { text: `💰 累计 $${cost} · 当前上下文 ${ctxStr}` });
      return;
    }

    case 'compact': {
      if (isBusy) {
        emitMsg(actorId, fromId, 'text', { text: '⚠️ 终端忙碌中，请等空闲后执行 /compact' });
        return;
      }
      // 把 "/compact" 当作普通用户消息插回队列，走正常 deliver 路径
      db.prepare(
        'INSERT INTO messages (from_id, to_id, kind, payload, ts) VALUES (?,?,?,?,?)'
      ).run(fromId, actorId, 'text', JSON.stringify({ text: '/compact' }), Date.now());
      sendToCore({ event: 'new_message', actorId });
      return;
    }

    case 'clear': {
      if (isBusy) {
        emitMsg(actorId, fromId, 'text', { text: '⚠️ 终端忙碌中，请等空闲后执行 /clear' });
        return;
      }
      resetSession(ctx);
      emitMsg(actorId, fromId, 'text', { text: '🗑 会话已重置' });
      return;
    }

    case 'model': {
      if (isBusy) {
        emitMsg(actorId, fromId, 'text', { text: '⚠️ 终端忙碌中，请等空闲后切换模型' });
        return;
      }
      const model = payload.model;
      if (!model) return;
      const row = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
      const meta = JSON.parse(row?.meta || '{}');
      meta.model = model;
      if (payload.provider) meta.provider = payload.provider;
      // 跨 provider 切换必须重算 env：漏了会把 deepseek 等第三方模型名发给 Anthropic API。
      // 切回 host Claude（resolveEnv 返回空）则删掉残留的第三方 env，回落 OAuth credentials。
      const { providerEnv = {} } = resolveByModel(model);
      if (Object.keys(providerEnv).length) meta.providerEnv = providerEnv;
      else delete meta.providerEnv;
      // contextWindow 随模型走：查不到登记值就删掉旧值，回落前端 1_000_000 兜底，
      // 不留上一个模型的窗口数误导百分比。
      const contextWindow = resolveContextWindow(model);
      if (contextWindow) meta.contextWindow = contextWindow;
      else delete meta.contextWindow;
      // sessionModel 是"CC 实际确认的模型"展示字段，切换后先清掉，下轮 init 事件回写新值
      delete meta.sessionModel;
      db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);
      entry.state.meta = meta;
      entry.state.model = model;
      killChild(entry);
      sendToCore({ event: 'actor_updated', actorId });
      emitMsg(actorId, fromId, 'text', { text: `🔄 已切换到 ${model}（对话保留）` });
      return;
    }
  }
}

function resetSession(ctx) {
  const { actorId, entry, db, sendToCore } = ctx;
  killChild(entry);
  entry.state.sessionId = null;
  const row = db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
  const meta = JSON.parse(row?.meta || '{}');
  delete meta.sessionId;
  delete meta.sessionModel;
  db.prepare('UPDATE actors SET meta=? WHERE id=?').run(JSON.stringify(meta), actorId);
  sendToCore({ event: 'actor_updated', actorId });
}

function killChild(entry) {
  if (entry.child && entry.child.exitCode === null) {
    try { entry.child.kill('SIGTERM'); } catch {}
  }
}
