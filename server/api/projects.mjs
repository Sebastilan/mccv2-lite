// projects.mjs — 项目发现 + 最近使用排序（GET /api/projects + touchRecentProject）

import { readdirSync, statSync, mkdirSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { json } from './_helpers.mjs';
import { WORKSPACE_ROOT } from '../ops/config.mjs';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const DATA_DIR    = join(__dirname, '..', '..', 'data');
const RECENT_FILE = join(DATA_DIR, 'recent_projects.json');
const CCA_ROOT    = WORKSPACE_ROOT;
const SKIP_DIRS   = new Set(['node_modules', 'tmp', 'memory']);

// ── 内存缓存（name → timestamp） ─────────────────────────────────────────
let recent = {};
try { recent = JSON.parse(readFileSync(RECENT_FILE, 'utf8')); } catch { /* first run */ }

// ── 目录扫描（每次请求实时扫，按"最近活跃"倒序） ─────────────────────────
// 活跃 = max(touchRecentProject 时间戳, 该项目下所有 actor 的 last_seen)
function _scanDirs(bus) {
  // 一次性聚合 bus.db 中所有 actor 的项目活跃时间（basename → max last_seen）
  const actorActive = {};
  if (bus?.db) {
    try {
      const rows = bus.db.prepare("SELECT meta, last_seen FROM actors WHERE meta IS NOT NULL").all();
      for (const r of rows) {
        try {
          const pp = JSON.parse(r.meta)?.projectPath;
          if (!pp) continue;
          const name = pp.split('/').filter(Boolean).pop();
          if (!name) continue;
          if ((r.last_seen || 0) > (actorActive[name] || 0)) actorActive[name] = r.last_seen;
        } catch {}
      }
    } catch {}
  }
  // 目录本身的诞生/修改时间也算活跃信号（新建项目尚无 actor 也能排前）
  const dirActive = (n) => {
    try {
      const s = statSync(`${CCA_ROOT}/${n}`);
      return Math.max(s.birthtimeMs || 0, s.mtimeMs || 0);
    } catch { return 0; }
  };
  const score = (n) => Math.max(recent[n] || 0, actorActive[n] || 0, dirActive(n));
  try {
    return readdirSync(CCA_ROOT)
      .filter(n => !n.startsWith('.') && !SKIP_DIRS.has(n))
      .filter(n => { try { return statSync(`${CCA_ROOT}/${n}`).isDirectory(); } catch { return false; } })
      .sort((a, b) => {
        const ta = score(a), tb = score(b);
        if (ta !== tb) return tb - ta;
        return a.localeCompare(b);
      })
      .map(n => ({ name: n, path: `${CCA_ROOT}/${n}` }));
  } catch { return []; }
}

// ── 公共 API ──────────────────────────────────────────────────────────────

/** 更新项目最近使用时间（write-through：先改内存，异步写磁盘） */
export function touchRecentProject(projectName) {
  if (!projectName) return;
  recent[projectName] = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFile(RECENT_FILE, JSON.stringify(recent)).catch(() => {});
}

/** handle(req, res, bus) — 处理 GET /api/projects */
export function handle(req, res, bus) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    json(res, { pinned: [], projects: _scanDirs(bus) });
    return true;
  }
  return false;
}
