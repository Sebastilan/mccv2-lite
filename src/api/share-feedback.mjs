// share-feedback.mjs — 批注列表 → markdown → user_msg 写回 bus（主板）
//
// 职责：feedback 触发时把暂存批注拼成可读 markdown，作为人类 user_msg 发给原 CC actor。
// 不写 HTTP 端点（review.mjs 调用本模块），不动批注存储（biz.db review_annotations）。
import path from 'path';
import { bizDb } from '../biz-db.mjs';

/**
 * 把 token 当前未投递的批注拼成 markdown 并写回 bus 为 user_msg。
 * @param {string} token
 * @param {object} bus  主总线实例（main.mjs 注入）
 * @param {number[]|null} annotationIds  可选；不传则提交所有未投递条目
 * @returns {{ ok:boolean, messageId?:number, delivered:number, error?:string }}
 */
export function submitFeedback(token, bus, annotationIds = null) {
  const rf = bizDb.prepare('SELECT * FROM review_files WHERE token = ?').get(token);
  if (!rf) return { ok: false, delivered: 0, error: 'token not found' };
  if (rf.expires_at < Date.now()) return { ok: false, delivered: 0, error: 'token expired' };
  if (!rf.from_actor) return { ok: false, delivered: 0, error: 'no from_actor to deliver to' };

  let rows;
  if (Array.isArray(annotationIds) && annotationIds.length) {
    const placeholders = annotationIds.map(() => '?').join(',');
    rows = bizDb.prepare(
      `SELECT * FROM review_annotations WHERE token = ? AND delivered = 0 AND id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(token, ...annotationIds);
  } else {
    rows = bizDb.prepare(
      'SELECT * FROM review_annotations WHERE token = ? AND delivered = 0 ORDER BY created_at ASC'
    ).all(token);
  }
  if (!rows.length) return { ok: false, delivered: 0, error: 'no pending annotations' };

  const name = path.basename(rf.path);
  const lines = [`### 对 \`${name}\` 的批注（${rows.length} 条）`, ''];
  rows.forEach((r, i) => {
    const anchor = r.anchor ? ` _@ ${r.anchor}_` : '';
    lines.push(`${i + 1}.${anchor} ${r.text}`);
  });
  const markdown = lines.join('\n');

  const messageId = bus.insertMessage({
    from_id: 'human_self',
    to_id: rf.from_actor,
    kind: 'user_msg',
    payload: { text: markdown, source: 'review-feedback', token },
    ts: Date.now(),
  });

  const ids = rows.map(r => r.id);
  bizDb.prepare(
    `UPDATE review_annotations SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids);

  return { ok: true, messageId, delivered: rows.length };
}
