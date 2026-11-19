// worker-callback.mjs — worker busy→idle 时给 advisor 发 worker_done；保活复用；idle 超时周期扫库回收
//
// 职责（单一）：
//   1. worker busy→idle 时，若本轮 idle 尚未通知，向 advisor 发 user_msg + event/worker_done
//   2. attach 时立即扫一次 + 周期扫库（setInterval）回收超龄 idle worker——重启不丢、无回收空窗
//   3. 回收动作 → stop_actor + 标 gone
//
// 去重：DB 推导（最新 worker_done ts vs 之后是否有新 incoming user_msg），无进程内 Set，重启稳定。
// 回收：DB 推导（status='idle' AND last_seen 超龄），无进程内 setTimeout，重启稳定——
//   主进程重启后定时器全清会让已 idle 的 worker 永远等不到回收，故改周期扫库与去重哲学统一。
// 复用：允许——V1 advisor↔worker 几个月稳定就是 reuse 模式。死循环根因是 V2 协议层 SQL filter
// 漏把 event 喂成 user_msg（commit f89cc9b 已修，cc-pool 只投 user_msg/text），与复用机制无关。
//
// 文档：docs/advisor-worker.md

const IDLE_AUTO_CLOSE_MS = 45 * 60 * 1000;  // idle 超过此时长的 worker 被回收
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;    // 每 5 分钟扫一次库
let sweepTimer = null;                        // 模块级 interval 句柄

export function attachWorkerCallback(bus, poolSupervisor, broadcaster) {
  bus.on('actor_status', ({ actorId, status }) => {
    if (status !== 'idle') return;
    handleIdle(bus, actorId);
  });

  // 周期扫库回收超龄 idle worker（重启稳定，不依赖进程内定时器）
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => sweepIdleWorkers(bus, poolSupervisor, broadcaster), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();  // 不吊住进程（测试/退出友好）

  // attach 时立即扫一次：主进程重启后泄漏 worker 被秒收，而非等满第一个 5 分钟周期
  sweepIdleWorkers(bus, poolSupervisor, broadcaster);
}

function handleIdle(bus, actorId) {
  const row = bus.db.prepare('SELECT meta FROM actors WHERE id=?').get(actorId);
  if (!row) return;
  let meta;
  try { meta = JSON.parse(row.meta || '{}'); } catch { return; }
  const cb = meta.callbackActorId;
  if (!cb) return;

  if (!shouldNotify(bus, actorId)) return;

  const summary = readLastText(bus, actorId);
  const workerName = meta.name || actorId;
  const ts = Date.now();

  // from_id 用系统 pseudo，避免污染 advisor 的 cc-pool lastFrom（否则 advisor 后续 text
  // 输出会被 emitMsg 路由回 worker，worker 把它当输入跑 → 死循环；2026-05-25 复现过）。
  // 消息体里包含 workerId/workerName，UI/CC 仍能识别来源。
  const SYS_FROM = 'system:worker-callback';

  // 异常结束判别：worker 回合被上游 API 错误杀死(进程转 idle)时,最后一条 text 形如
  // `API Error: Stream idle timeout ...` / `API Error: ...ECONNRESET...`,均以 `API Error:` 开头。
  // 只看开头(^),不用 contains——避免误伤正常汇报里提到 "API Error" 的文本。
  const isApiError = /^API Error:/.test(summary || '');
  // 打断判别：advisor 中途改主意 → POST /interrupt → worker 立刻转 idle，这条 idle 会走到这里。
  // 不判别的话 advisor 会收到「已完成」+ 半截输出当摘要——它刚亲手叫停的活被报成干完了。
  const interrupted = !isApiError && wasInterrupted(bus, actorId);
  const userText = isApiError
    ? `[Worker ${workerName} (${actorId}) 异常结束(API 错误),任务可能未完成,建议核查后重派]\n末条输出：${summary || '(无文本输出)'}`
    : interrupted
    ? `[Worker ${workerName} (${actorId}) 已被打断,任务未完成]\n打断前最后输出：${summary || '(无文本输出)'}`
    : `[Worker ${workerName} (${actorId}) 已完成]\n摘要：${summary || '(无文本输出)'}`;

  bus.insertMessage({
    from_id: SYS_FROM, to_id: cb, kind: 'user_msg',
    payload: { text: userText },
    ts,
  });
  bus.insertMessage({
    from_id: SYS_FROM, to_id: cb, kind: 'event',
    payload: {
      name: 'worker_done', workerId: actorId, summary,
      status: isApiError ? 'error' : interrupted ? 'interrupted' : 'idle',
    },
    ts,
  });
}

// 本轮 idle 是否该通知：最新 worker_done 之后有无新 incoming user_msg？
// - 没发过 done → 通知（首次）
// - 发过 done，且之后有新 user_msg 进来（被复用）→ 通知
// - 发过 done，之后无新 user_msg（同一轮的回响）→ 跳过
function shouldNotify(bus, actorId) {
  const lastDone = bus.db.prepare(
    `SELECT ts FROM messages
       WHERE from_id='system:worker-callback' AND kind='event'
         AND payload LIKE '%"workerId":"' || ? || '"%'
       ORDER BY id DESC LIMIT 1`
  ).get(actorId);
  if (!lastDone) return true;
  const lastIncoming = bus.db.prepare(
    "SELECT ts FROM messages WHERE to_id=? AND kind='user_msg' ORDER BY id DESC LIMIT 1"
  ).get(actorId);
  return !!(lastIncoming && lastIncoming.ts > lastDone.ts);
}

// 这轮 idle 是不是被打断打出来的：最近一条 interrupt control 晚于最近一条 incoming user_msg
// → 说明任务派下去之后有人喊停，本轮不是自然跑完。同样走 DB 推导，与去重/回收的哲学一致。
function wasInterrupted(bus, actorId) {
  const lastInterrupt = bus.db.prepare(
    "SELECT ts FROM messages WHERE to_id=? AND kind='control' AND payload LIKE '%\"interrupt\"%' ORDER BY id DESC LIMIT 1"
  ).get(actorId);
  if (!lastInterrupt) return false;
  const lastIncoming = bus.db.prepare(
    "SELECT ts FROM messages WHERE to_id=? AND kind='user_msg' ORDER BY id DESC LIMIT 1"
  ).get(actorId);
  return !lastIncoming || lastInterrupt.ts >= lastIncoming.ts;
}

function readLastText(bus, actorId) {
  const last = bus.db.prepare(
    "SELECT payload FROM messages WHERE from_id=? AND kind IN ('text','assistant_msg') ORDER BY id DESC LIMIT 1"
  ).get(actorId);
  if (!last) return '';
  try { return (JSON.parse(last.payload).text || '').slice(0, 200); } catch { return ''; }
}

// 周期扫库：回收所有超龄 idle worker。
// 铁律：只回收 meta.callbackActorId 存在的（worker）；advisor 无此字段 → 永不动。
export function sweepIdleWorkers(bus, poolSupervisor, broadcaster) {
  const cutoff = Date.now() - IDLE_AUTO_CLOSE_MS;
  const rows = bus.db.prepare(
    "SELECT id, meta FROM actors WHERE status='idle' AND last_seen < ?"
  ).all(cutoff);
  for (const { id, meta } of rows) {
    let m;
    try { m = JSON.parse(meta || '{}'); } catch { continue; }
    if (!m.callbackActorId) continue;  // advisor → 不动（铁律）
    poolSupervisor?.stopActor(id);
    bus.db.prepare("UPDATE actors SET status='gone', last_seen=? WHERE id=?").run(Date.now(), id);
    broadcaster?.broadcastActorGone(id);
    bus.emit('actor_status', { actorId: id, status: 'gone' });  // 'gone' 是头等公民事件，policy 层反应式订阅
  }
}

// 测试钩子
export function _stopIdleSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

export function _sweepNow(bus, poolSupervisor, broadcaster) {
  sweepIdleWorkers(bus, poolSupervisor, broadcaster);
}
