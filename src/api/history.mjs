// history.mjs — 历史会话路由薄壳（列表 / 搜索 / 详情 / resume）
// 扫描职责委托给 src/scanners/，actor 创建复用 createCcActor。

import { json, readBody } from './_helpers.mjs';
import { createCcActor } from '../api-actors.mjs';
import {
  listSessions, getSession, getSessionMessages, invalidate as invalidateCcSessions,
} from '../scanners/cc-sessions.mjs';
import { searchSessions, getConversationFile } from '../scanners/conversations.mjs';

export function handleHistoryApi(req, res, bus, poolSupervisor, broadcaster) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/history') {
    json(res, mergeCustomNames(bus, listSessions()));
    return true;
  }
  if (method === 'GET' && p === '/api/history/search') {
    const q = url.searchParams.get('q') || '';
    json(res, q ? searchSessions(q) : []);
    return true;
  }
  if (method === 'POST' && p === '/api/history/refresh') {
    invalidateCcSessions();
    json(res, mergeCustomNames(bus, listSessions()));
    return true;
  }
  if (method === 'GET' && p === '/api/history/conversation') {
    const fileId = url.searchParams.get('fileId') || '';
    const msgs = getConversationFile(fileId);
    if (!msgs) { json(res, { error: 'not found' }, 404); return true; }
    const project = fileId.split('/')[0] || '';
    json(res, { session: { project, ts: Date.now() }, messages: msgs });
    return true;
  }
  const histDetail = p.match(/^\/api\/history\/([0-9a-f-]{36})$/);
  if (histDetail && method === 'GET') {
    const session = getSession(histDetail[1]);
    if (!session) { json(res, { error: 'not found' }, 404); return true; }
    const { _filePath: _, ...clean } = session;
    json(res, { session: clean, messages: getSessionMessages(histDetail[1]) });
    return true;
  }
  const histResume = p.match(/^\/api\/history\/([0-9a-f-]{36})\/resume$/);
  if (histResume && method === 'POST') {
    readBody(req).then((raw) => {
      // body 可选带 { model }：用户在抽屉里选的 API/模型；空 body / 坏 JSON → 用默认(不塞 model)
      let model = '';
      try { const b = JSON.parse(raw || '{}'); if (b && typeof b.model === 'string') model = b.model.trim(); } catch { /* 容错：无 model */ }
      const session = getSession(histResume[1]);
      if (!session) { json(res, { error: 'session not found' }, 404); return; }
      const [merged] = mergeCustomNames(bus, [{ sessionId: session.sessionId, project: session.project }]);
      const meta = {
        projectPath: session.cwd,
        sessionId: session.sessionId,
        resumedFrom: session.sessionId,
        name: merged.customName || session.project || '',
      };
      // model 透传给 createCcActor → resolveByModel 自动配 --model + 对应 providerEnv
      if (model) meta.model = model;
      const r = createCcActor({ meta, bus, poolSupervisor, broadcaster });
      if (!r.ok) { json(res, { error: r.error }, r.code || 500); return; }
      json(res, { actorId: r.actorId, terminalId: r.actorId });
    }).catch(() => json(res, { error: 'bad request' }, 400));
    return true;
  }
  return false;
}

// 把 bus 中现存 actor 的 name（按 meta.sessionId 索引）回填给历史会话
function mergeCustomNames(bus, sessions) {
  const rows = bus.db.prepare("SELECT meta FROM actors WHERE meta IS NOT NULL AND meta != '{}'").all();
  const names = Object.create(null);
  for (const r of rows) {
    try {
      const m = JSON.parse(r.meta);
      if (m.sessionId && m.name) names[m.sessionId] = m.name;
    } catch { /* skip */ }
  }
  return sessions.map(s => names[s.sessionId] ? { ...s, customName: names[s.sessionId] } : s);
}
