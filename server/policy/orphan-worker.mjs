// orphan-worker.mjs — advisor gone 时级联关闭其名下所有 worker
//
// 职责（单一）：订阅 bus 'actor_status'，若 status='gone' 且该 actor 是某些 worker 的
// callback 目标，逐一 stop_actor 这些孤儿 worker。
//
// 为什么独立成文件不并进 worker-callback：
//   worker-callback 处理 worker→advisor 方向（idle 通知 + idle timer）
//   orphan-worker 处理 advisor→workers 方向（advisor 死亡 → 级联回收）
//   方向相反、触发不同、关注点正交，分文件符合"一文一职"
//
// 触发路径：①DELETE /api/actors（api-actors.mjs）②cc-pool 子进程崩溃（notify-server actor_gone）
// 两条路径都会 bus.emit('actor_status', { status:'gone' })，本 policy 统一订阅。
//
// 文档：docs/advisor-worker.md

export function attachOrphanWorker(bus, poolSupervisor, broadcaster) {
  bus.on('actor_status', ({ actorId, status }) => {
    if (status !== 'gone') return;
    const orphans = bus.db.prepare(
      `SELECT id FROM actors
        WHERE status != 'gone'
          AND json_extract(meta, '$.callbackActorId') = ?`
    ).all(actorId);
    if (!orphans.length) return;
    const ts = Date.now();
    for (const { id } of orphans) {
      poolSupervisor?.stopActor(id);
      bus.db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?").run(ts, id);
      broadcaster?.broadcastActorGone(id);
      bus.emit('actor_status', { actorId: id, status: 'gone' });  // 链式级联（如 worker 自己又是某 worker 的 advisor——目前禁止嵌套但保持事件一致性）
    }
  });
}
