// actor-bus/message-context.mjs — 投递前的 text 加工集中地
// 把所有"发给 CC 子进程的 stdin 前要做的文本增强"都收敛在这里：
//   - buildFromHeader：actor → actor 消息加 [from: id (name)] 头（human_self/system 不加）
//   - buildMentionContext：meta.mentions 非空时追加 [引用上下文] 块
//   - wrapDeliveryText：组合器，cc-pool 投递时一行调用
// 单一职责：所有相关失败都退化为原文 + console.warn，绝不抛错拖垮 deliverOne

/**
 * 给 actor → actor 消息加 [from: id (name)] 头；返回末尾不带换行的字符串（'' 表示不加头）。
 * 跳过：human_self / system:* / 数据库里查不到的 from_id（系统伪源、未知发件人）
 */
export function buildFromHeader(db, fromId) {
  if (!fromId || fromId === 'human_self' || fromId.startsWith('system:')) return '';
  try {
    const row = db.prepare('SELECT id, meta FROM actors WHERE id=?').get(fromId);
    if (!row) return '';  // 未知发件人（可能已 gone 后删），不加误导性头
    let metaObj = {};
    try { metaObj = JSON.parse(row.meta || '{}'); } catch {}
    // 显示名优先级：meta.name → projectPath 末段（多数 actor 没主动设 name，靠 projectPath 区分）
    const projectTail = (metaObj.projectPath || '').split('/').filter(Boolean).pop() || '';
    const display = metaObj.name || projectTail || '';
    return display ? `[from: ${row.id} (${display})]` : `[from: ${row.id}]`;
  } catch (e) {
    console.warn('[actor-bus] buildFromHeader failed:', e?.message);
    return '';
  }
}

/**
 * meta.mentions 非空时，返回 [引用上下文] 块（含工具提示），不带前导/后置换行（由组合器加）。
 * 返回 '' 表示无 mentions 或全部解析失败。
 */
export function buildMentionContext(db, mentions) {
  if (!Array.isArray(mentions) || !mentions.length) return '';
  try {
    const lines = ['[引用上下文]'];
    for (const m of mentions) {
      if (!m?.actor_id) continue;
      const actor = db.prepare('SELECT id, status, meta FROM actors WHERE id=?').get(m.actor_id);
      if (!actor) {
        lines.push(`- @${m.name || m.actor_id} (${m.actor_id}, 不存在)`);
        continue;
      }
      let metaObj = {}; try { metaObj = JSON.parse(actor.meta || '{}'); } catch {}
      const displayName = m.name || metaObj.name || actor.id;
      const last = db.prepare(
        "SELECT payload FROM messages WHERE (to_id=? OR from_id=?) AND kind IN ('user_msg','text') ORDER BY id DESC LIMIT 1"
      ).get(actor.id, actor.id);
      let lastText = '';
      if (last) {
        try { lastText = (JSON.parse(last.payload).text || '').slice(0, 80).replace(/\s+/g, ' '); } catch {}
      }
      lines.push(`- @${displayName} (id=${actor.id}, status=${actor.status}${lastText ? `, 最近: "${lastText}"` : ''})`);
    }
    lines.push('可用 mcp__actor__read_messages 读它的消息历史，mcp__actor__send_message 给它发消息。');
    return lines.join('\n');
  } catch (e) {
    console.warn('[actor-bus] buildMentionContext failed:', e?.message);
    return '';
  }
}

/**
 * 组合器：cc-pool deliverOne 一行调用。
 * 输出结构：
 *   [from: ...]\n        ← 头（actor→actor 才有）
 *   <原文>\n
 *   [引用上下文]\n         ← 尾（mentions 非空才有）
 *   ...
 */
export function wrapDeliveryText({ db, fromId, text, mentions }) {
  const header = buildFromHeader(db, fromId);
  const ctx    = buildMentionContext(db, mentions);
  const parts = [];
  if (header) parts.push(header);
  parts.push(text || '');
  if (ctx) parts.push('', ctx);
  return parts.join('\n');
}
