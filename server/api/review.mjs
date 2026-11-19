// review.mjs — 审阅 HTTP API（薄壳，业务逻辑在 share.mjs + share-feedback.mjs）
//
// 端点（详见 protocol/review-api.md）：
//   POST /api/review/share                 注册路径换 token
//   GET  /api/review/:token/meta           元数据
//   GET  /api/review/:token                原文流
//   GET  /api/review/:token/annotations    列暂存批注
//   POST /api/review/:token/annotate       暂存单条批注（不发 bus）
//   POST /api/review/:token/feedback       提交批注 → user_msg 写回 bus
import { bizDb } from '../bus/biz-db.mjs';
import { json, readBody } from './_helpers.mjs';
import { createReadStream, existsSync, statSync } from 'fs';
import path from 'path';
import { register, get as getShare } from '../review/share.mjs';
import { submitFeedback } from '../review/share-feedback.mjs';

const MAX_ANNOTATION_LEN = 5 * 1024;

function err(res, code, errStr, detail = '') {
  json(res, { error: errStr, detail }, code);
}

function mimeForExt(ext) {
  const m = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.csv': 'text/csv',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.avif': 'image/avif',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    // 音视频（浏览器 <video>/<audio> 直接播，需配 Range 支持）
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.ogv': 'video/ogg', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.opus': 'audio/ogg', '.flac': 'audio/flac',
  };
  return m[ext] || 'text/plain';
}

function isImageExt(ext) {
  return ['.jpg','.jpeg','.png','.gif','.webp','.svg','.bmp','.avif'].includes(ext);
}

const VIDEO_EXTS = ['.mp4','.m4v','.webm','.ogv','.mov','.mkv','.avi'];
const AUDIO_EXTS = ['.mp3','.m4a','.aac','.wav','.ogg','.oga','.opus','.flac'];

export function isMediaExt(ext) {
  return VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext);
}

function isBinaryExt(ext) {
  return isImageExt(ext) || isMediaExt(ext)
    || ['.pdf','.docx','.doc','.xlsx','.xls','.xlsm'].includes(ext);
}

export function handle(req, res, bus) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!pathname.startsWith('/api/review')) return false;

  // POST /api/review/share — 注册路径换 token
  if (req.method === 'POST' && pathname === '/api/review/share') {
    readBody(req).then(body => {
      const { path: filePath, from_actor, ttl_seconds } = JSON.parse(body);
      if (!filePath) return err(res, 400, 'path-required');
      const payload = register(filePath, from_actor ?? null, ttl_seconds);
      if (!payload) return err(res, 400, 'path-rejected', 'must be an existing absolute path under the workspace or /tmp');
      json(res, { ...payload, url: `/review.html?token=${payload.token}` }, 201);
    }).catch(e => err(res, 400, 'bad-request', e.message));
    return true;
  }

  const m = pathname.match(/^\/api\/review\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const token = m[1];
  const sub = m[2] || '';

  const rf = getShare(token);
  if (!rf) { err(res, 404, 'not-found-or-expired'); return true; }

  // GET /api/review/:token/meta
  if (req.method === 'GET' && sub === '/meta') {
    const ext = path.extname(rf.path).toLowerCase();
    let size = 0;
    try { size = statSync(rf.path).size; } catch {}
    json(res, {
      token,
      name: path.basename(rf.path),
      ext,
      mode: 'review',           // 当前只支持 review
      mimeType: mimeForExt(ext),
      size,
      from_actor: rf.from_actor ?? null,
    });
    return true;
  }

  // GET /api/review/:token — 原文流（音视频走 Range，才能拖进度条 / iOS Safari 才肯播）
  if (req.method === 'GET' && sub === '') {
    const servePath = rf.blob_path && existsSync(rf.blob_path) ? rf.blob_path : rf.path;
    if (!existsSync(servePath)) { err(res, 410, 'source-gone'); return true; }
    const ext = path.extname(servePath).toLowerCase();
    const mime = mimeForExt(ext);
    const isBinary = isBinaryExt(ext);
    const ctype = isBinary ? mime : `${mime}; charset=utf-8`;
    const size = statSync(servePath).size;

    const range = isMediaExt(ext) ? String(req.headers.range || '') : '';
    const rm = range.match(/^bytes=(\d*)-(\d*)$/);
    if (rm && (rm[1] || rm[2])) {
      let start, end;
      if (rm[1]) { start = Number(rm[1]); end = rm[2] ? Number(rm[2]) : size - 1; }
      else { start = Math.max(0, size - Number(rm[2])); end = size - 1; }   // bytes=-N 后缀请求
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return true;
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        'Content-Type': ctype,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      createReadStream(servePath, { start, end }).pipe(res);
      return true;
    }

    const headers = { 'Content-Type': ctype, 'Content-Length': size };
    if (isMediaExt(ext)) headers['Accept-Ranges'] = 'bytes';
    res.writeHead(200, headers);
    createReadStream(servePath).pipe(res);
    return true;
  }

  // GET /api/review/:token/annotations
  if (req.method === 'GET' && sub === '/annotations') {
    const list = bizDb.prepare(
      'SELECT id, anchor, text, created_at, delivered FROM review_annotations WHERE token = ? ORDER BY created_at ASC'
    ).all(token);
    json(res, list);
    return true;
  }

  // POST /api/review/:token/annotate — 仅暂存
  if (req.method === 'POST' && sub === '/annotate') {
    readBody(req).then(body => {
      const { anchor, text } = JSON.parse(body);
      if (!text) return err(res, 400, 'text-required');
      if (text.length > MAX_ANNOTATION_LEN) return err(res, 400, 'text-too-long', `max ${MAX_ANNOTATION_LEN} chars`);
      const info = bizDb.prepare(
        'INSERT INTO review_annotations (token, anchor, text, created_at, delivered) VALUES (?, ?, ?, ?, 0)'
      ).run(token, anchor ?? null, text, Date.now());
      bizDb.prepare('UPDATE review_files SET annotation_count = annotation_count + 1 WHERE token = ?').run(token);
      const row = bizDb.prepare('SELECT * FROM review_annotations WHERE id = ?').get(info.lastInsertRowid);
      json(res, row, 201);
    }).catch(e => err(res, 400, 'bad-request', e.message));
    return true;
  }

  // POST /api/review/:token/feedback — 提交反馈写回 bus 为 user_msg
  // 兼容两种 payload：
  //   { markdown: "..." }            → 直发（旧 review.html 用）
  //   {} / { annotation_ids: [...] } → 从 review_annotations 拼 markdown（Phase 3 新流程）
  if (req.method === 'POST' && sub === '/feedback') {
    readBody(req).then(body => {
      const parsed = body ? JSON.parse(body) : {};
      // 直发 markdown 模式
      if (parsed.markdown) {
        if (!rf.from_actor) return err(res, 400, 'no-from-actor');
        const mid = bus.insertMessage({
          from_id: 'human_self',
          to_id: rf.from_actor,
          kind: 'user_msg',
          payload: { text: parsed.markdown, source: 'review-feedback', token },
          ts: Date.now(),
        });
        return json(res, { ok: true, messageId: mid, delivered: 1 });
      }
      // 暂存 annotations 提交模式
      const result = submitFeedback(token, bus, parsed.annotation_ids);
      if (!result.ok) return err(res, result.error?.includes('expired') ? 410 : 400, result.error);
      json(res, result);
    }).catch(e => err(res, 400, 'bad-request', e.message));
    return true;
  }

  return false;
}
