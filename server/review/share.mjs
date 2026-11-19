// share.mjs — 审阅文件注册 + mode 路由 + 文本 [SHARE:] 拆分（主板，业务薄壳调用）
//
// 职责（一文一职）：
//   1. path → token + mode 路由（按扩展名）
//   2. 注册写 biz.db review_files
//   3. 文本中扫描 [SHARE:] 标记，拆出来生成 share 消息
//   4. 安全边界：只允许 SHARE_ROOTS（工作区、/tmp 等，见 config.mjs）下的绝对路径
//
// 不做：HTTP 端点（review.mjs）、批注（review.mjs + share-feedback.mjs）、前端渲染（plugins/share-card.js）
import crypto from 'crypto';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { bizDb } from '../bus/biz-db.mjs';
import { SHARE_ROOTS } from '../ops/config.mjs';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ALLOWED_ROOTS = SHARE_ROOTS;
const DEFAULT_TTL_SECONDS = 86400; // 24h

// mode 路由表（按扩展名）—— 加新 mode 只改这里
const MODE_BY_EXT = {
  review: new Set([
    '.md', '.txt', '.log',
    '.js', '.mjs', '.ts', '.tsx', '.jsx',
    '.py', '.go', '.rs', '.java',
    '.json', '.yaml', '.yml', '.toml',
    '.css', '.scss', '.less',
    '.sh', '.bash', '.ps1',
    '.sql', '.xml', '.csv', '.html', '.htm',
  ]),
  // 音视频：review.html 里直接起 <video>/<audio> 播（后端配 Range）
  media: new Set([
    '.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv', '.avi',
    '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac',
  ]),
  // 'visual-review': new Set(['.pdf']),     // 未来
  // image:          new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']),
  // xlsx:           new Set(['.xlsx', '.xls']),
};

function genToken() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes).map(b => BASE62[b % 62]).join('');
}

function detectMode(ext) {
  for (const [mode, exts] of Object.entries(MODE_BY_EXT)) {
    if (exts.has(ext)) return mode;
  }
  return 'download';
}

function isPathAllowed(abs) {
  return ALLOWED_ROOTS.some(root => abs.startsWith(root));
}

/**
 * 注册一个文件，返回 share payload。
 * @param {string} filePath 必须绝对路径
 * @param {string|null} fromActor 触发的 CC actor id，反馈回流到它
 * @param {number} ttlSeconds
 * @returns {object|null} { token, name, mode, mimeType, size, registeredAt } 或 null（路径非法/不存在）
 */
export function register(filePath, fromActor = null, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  const abs = path.resolve(filePath);
  if (!isPathAllowed(abs)) return null;
  if (!existsSync(abs)) return null;

  const ext = path.extname(abs).toLowerCase();
  const mode = detectMode(ext);
  const name = path.basename(abs);
  let size = 0;
  try { size = statSync(abs).size; } catch {}

  const token = genToken();
  const now = Date.now();
  bizDb.prepare(
    'INSERT INTO review_files (token, path, from_actor, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, abs, fromActor, now, now + ttlSeconds * 1000);

  return {
    token, name, mode,
    mimeType: mimeFor(ext),
    size,
    registeredAt: now,
  };
}

/** 取注册信息（含 from_actor + path）；过期返 null */
export function get(token) {
  const row = bizDb.prepare('SELECT * FROM review_files WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

/** 扫文本中所有 [SHARE:path] 标记 → 拆出 shares + 干净文本 */
export function parseAndExtractShares(text, fromActor) {
  const shares = [];
  const cleanText = text.replace(/\[SHARE:([^\]]+)\]/g, (match, rawPath) => {
    const p = rawPath.trim();
    const payload = register(p, fromActor);
    if (payload) {
      shares.push(payload);
      return '';  // 从文本里抠掉 SHARE 标记
    }
    return match;  // 注册失败，保留原文以便用户看到出错的字面
  });
  return { cleanText: cleanText.replace(/\s+\n/g, '\n').trim(), shares };
}

function mimeFor(ext) {
  const map = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.csv': 'text/csv', '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}
