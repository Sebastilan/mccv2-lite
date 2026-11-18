// attachments.mjs — 附件上传（SHA-256 去重）+ 流式下载（/api/attachments）
import { bizDb } from '../biz-db.mjs';
import { json, readRawBody } from './_helpers.mjs';
import crypto from 'crypto';
import { createReadStream, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOBS_DIR = path.resolve(__dirname, '../../data/blobs/attachments');

// Minimal multipart/form-data parser — extracts first file part
function parseMultipart(boundary, bodyBuf) {
  const startMark = Buffer.from(`--${boundary}\r\n`);
  const start = bodyBuf.indexOf(startMark);
  if (start === -1) throw new Error('invalid multipart: boundary not found');

  const headerStart = start + startMark.length;
  const sep = bodyBuf.indexOf('\r\n\r\n', headerStart);
  if (sep === -1) throw new Error('invalid multipart: header separator not found');

  const headers = bodyBuf.slice(headerStart, sep).toString('utf-8');
  const bodyStart = sep + 4;
  const endMark = Buffer.from(`\r\n--${boundary}`);
  const bodyEnd = bodyBuf.indexOf(endMark, bodyStart);
  const content = bodyEnd !== -1 ? bodyBuf.slice(bodyStart, bodyEnd) : bodyBuf.slice(bodyStart);

  const cdMatch = headers.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
  const filename = cdMatch ? cdMatch[1] : 'upload';
  const ctMatch  = headers.match(/Content-Type:\s*([^\r\n]+)/i);
  const mime     = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

  return { filename, mime, content };
}

function storeAttachment(filename, mime, content) {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const existing = bizDb.prepare('SELECT hash FROM attachments WHERE hash = ?').get(hash);
  if (!existing) {
    writeFileSync(path.join(BLOBS_DIR, hash), content);
    bizDb.prepare(
      'INSERT INTO attachments (hash, filename, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?)'
    ).run(hash, filename, mime, content.length, Date.now());
  }
  return { hash, filename, mime, size: content.length };
}

export function handle(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'POST' && pathname === '/api/attachments') {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=([^\s;]+)/);
    if (!m) { json(res, { error: 'expected multipart/form-data with boundary' }, 400); return true; }
    readRawBody(req).then(bodyBuf => {
      const { filename, mime, content } = parseMultipart(m[1], bodyBuf);
      json(res, storeAttachment(filename, mime, content), 201);
    }).catch(e => { json(res, { error: e.message }, 400); });
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/attachments/')) {
    const hash = pathname.slice('/api/attachments/'.length);
    const row = bizDb.prepare('SELECT * FROM attachments WHERE hash = ?').get(hash);
    if (!row) { json(res, { error: 'not found' }, 404); return true; }
    res.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': row.size,
      'Content-Disposition': `inline; filename="${row.filename}"`,
    });
    createReadStream(path.join(BLOBS_DIR, hash)).pipe(res);
    return true;
  }

  return false;
}
