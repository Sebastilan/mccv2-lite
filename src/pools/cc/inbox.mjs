// inbox.mjs — 用户发给 CC 的附件落地到本地 inbox（48h TTL），CC 可用 Read 直接取
import path from 'path';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';

const ROOT = path.resolve(process.env.MCC_DATA_DIR || path.join(process.cwd(), 'data'), 'inbox');
const TTL_MS = 48 * 60 * 60 * 1000;

function sanitize(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._\-一-龥]/g, '_').slice(0, 120) || 'file';
}

/**
 * 把一条 user_msg 携带的附件写到 data/inbox/<actor>/<msgId>_<filename>，返回落地路径数组。
 * 仅对带 base64 data 的附件落地；纯文本/无 data 的跳过（已在 stdin 里内联）。
 */
export function saveAttachmentsToInbox(actorId, msgId, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const dir = path.join(ROOT, actorId);
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const att of attachments) {
    const raw = String(att?.data || '');
    if (!raw) continue;
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
    if (!buf.length) continue;
    const fname = `${msgId}_${sanitize(att.name)}`;
    const fpath = path.join(dir, fname);
    try {
      writeFileSync(fpath, buf);
      saved.push(fpath);
    } catch (e) {
      console.warn(`[inbox] write failed: ${fpath} — ${e.message}`);
    }
  }
  return saved;
}

/** 扫 ROOT 下所有文件，mtime 超 TTL 即删；删空目录。 */
function sweepOnce() {
  let removed = 0;
  let actors;
  try { actors = readdirSync(ROOT); } catch { return 0; }
  const cutoff = Date.now() - TTL_MS;
  for (const actor of actors) {
    const dir = path.join(ROOT, actor);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      const fp = path.join(dir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); removed++; }
      } catch {}
    }
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch {}
  }
  return removed;
}

export function startInboxSweeper() {
  mkdirSync(ROOT, { recursive: true });
  const tick = () => {
    const n = sweepOnce();
    if (n) console.log(`[inbox] swept ${n} expired files`);
  };
  setInterval(tick, 60 * 60 * 1000);
  setTimeout(tick, 30 * 1000);
}
