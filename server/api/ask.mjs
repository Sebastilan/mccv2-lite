// ask.mjs — 阻塞式问答：MCP server POST 来 ask，HTTP long-poll 等用户点击答案
// 流程：
//   1. MCP server POST /api/ask {actorId, questions} → 生成 askId、insert ask_pending event
//      （from=actorId, to=human_self），HTTP 响应**挂住不返回**
//   2. 前端 WS 收到 ask_pending → 渲染可点击卡片，dataset 存 askId
//   3. 用户点选项 → 前端 POST /api/ask/<id>/answer {answers}
//   4. resolve 第 1 步挂住的 Promise → /api/ask 返回 {answers} → MCP server 喂回 CC
import { randomUUID } from 'crypto';
import { json, readBody } from './_helpers.mjs';

const TIMEOUT_MS = 30 * 60 * 1000;
const PENDING = new Map();  // askId → { resolve, timer, actorId }

let _bus = null;
export function setAskBus(bus) { _bus = bus; }

function emitEvent(actorId, payload) {
  if (!_bus) return;
  _bus.insertMessage({
    from_id: actorId,
    to_id: 'human_self',
    kind: 'event',
    payload,
    ts: Date.now(),
  });
}

export function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/ask(?:\/([^/]+)\/answer)?$/);
  if (!m) return false;
  const askId = m[1];

  if (!askId && req.method === 'POST') { createAsk(req, res); return true; }
  if (askId && req.method === 'POST')  { answerAsk(askId, req, res); return true; }
  return false;
}

async function createAsk(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return json(res, { error: 'invalid json' }, 400); }
  const { actorId, questions } = body;
  if (!actorId || !Array.isArray(questions) || !questions.length) {
    return json(res, { error: 'actorId + questions required' }, 400);
  }
  const askId = randomUUID();
  emitEvent(actorId, { event_type: 'ask_pending', ask_id: askId, questions });

  const answers = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (PENDING.has(askId)) {
        PENDING.delete(askId);
        resolve(questions.map(() => '__timeout__'));
      }
    }, TIMEOUT_MS);
    PENDING.set(askId, { resolve, timer, actorId });
  });

  json(res, { answers });
}

async function answerAsk(askId, req, res) {
  const entry = PENDING.get(askId);
  if (!entry) return json(res, { error: 'ask not found or already answered' }, 404);
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return json(res, { error: 'invalid json' }, 400); }
  const answers = Array.isArray(body.answers) ? body.answers : [String(body.answer || '')];
  clearTimeout(entry.timer);
  PENDING.delete(askId);
  emitEvent(entry.actorId, { event_type: 'ask_answered', ask_id: askId, answers });
  entry.resolve(answers);
  json(res, { ok: true });
}
