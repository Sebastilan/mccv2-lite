// pin-slots.mjs — 顶置占位声明 API（GET/PUT/DELETE）
//
// 外部项目（如 orchestrator/xiaoc-daemon）启动时 PUT 注册占位，撤销时 DELETE。
// 前端 GET 整张表渲染：无对应 actor 时显示 ghost 占位卡（点击 → 用 spawn_meta 创建）。
// MCC 对具体角色无任何认知，只是占位登记处。

import { bizDb } from '../bus/biz-db.mjs';
import { json, readBody } from './_helpers.mjs';

function listSlots() {
  return bizDb.prepare('SELECT id, label, spawn_meta, created_at, updated_at FROM pin_slots ORDER BY id').all()
    .map(r => ({ id: r.id, label: r.label, spawnMeta: JSON.parse(r.spawn_meta), createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function upsertSlot(id, label, spawnMeta) {
  const now = Date.now();
  bizDb.prepare(
    `INSERT INTO pin_slots (id, label, spawn_meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, spawn_meta = excluded.spawn_meta, updated_at = excluded.updated_at`
  ).run(id, label, JSON.stringify(spawnMeta), now, now);
}

function deleteSlot(id) {
  return bizDb.prepare('DELETE FROM pin_slots WHERE id = ?').run(id).changes > 0;
}

export function handle(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && pathname === '/api/pin-slots') {
    json(res, listSlots());
    return true;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/pin-slots/')) {
    const id = pathname.slice('/api/pin-slots/'.length);
    if (!id) { json(res, { error: 'missing slot id' }, 400); return true; }
    readBody(req).then(body => {
      const { label, spawnMeta } = JSON.parse(body);
      if (!label || !spawnMeta) { json(res, { error: 'label and spawnMeta required' }, 400); return; }
      upsertSlot(id, label, spawnMeta);
      json(res, { ok: true });
    }).catch(e => { json(res, { error: e.message }, 400); });
    return true;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/pin-slots/')) {
    const id = pathname.slice('/api/pin-slots/'.length);
    if (!id) { json(res, { error: 'missing slot id' }, 400); return true; }
    const ok = deleteSlot(id);
    json(res, ok ? { ok: true } : { error: 'not found' }, ok ? 200 : 404);
    return true;
  }

  return false;
}
