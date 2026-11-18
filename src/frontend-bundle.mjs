// frontend-bundle.mjs — 主线对 src/public/dist/ 构建产物的读侧抽象
//
// Contract — dist/manifest.json：
//   {
//     "version": 2,
//     "assets":    { "app.js": "dist/app.HASH.js", "style.css": "dist/style.HASH.css" },
//     "encodings": ["br", "gz"],
//     "builtAt":   "2026-05-25T..."
//   }
//
// 提供 5 个能力（写侧 = scripts/build-frontend.mjs，本模块只读）：
//   ensureFreshBundle()  启动门控：src 新于 manifest 则同步 build
//   getManifest()        当前 manifest 快照
//   watchManifest()      manifest 变化（build 完成）自动重读
//   templateHtml(html)   按 manifest.assets 替换 index.html 里 src=/href= 资源引用
//   pickEncoding(p, ae)  根据 Accept-Encoding 选最优 .br/.gz variant

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'src/public');
const DIST_DIR = path.join(PUBLIC_DIR, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const BUILD_SCRIPT = path.join(ROOT, 'scripts/build-frontend.mjs');

// 不进入 staleness 比较的子目录（dist 是产物，lib 是第三方）
const SKIP_DIRS = new Set(['dist', 'lib']);

let _manifest = null;

export function getManifest() { return _manifest; }

function loadManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) { _manifest = null; return; }
    _manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const names = Object.keys(_manifest?.assets || {}).join(', ');
    console.log(`[frontend-bundle] manifest loaded: ${names || '(empty)'}`);
  } catch (e) {
    _manifest = null;
    console.warn('[frontend-bundle] parse fail:', e.message);
  }
}

// ─── staleness 检测 ───
// 递归遍历 src/public/（跳过 dist/lib），返回最新 mtime
function newestSourceMtime() {
  let max = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs > max) max = st.mtimeMs;
    }
  };
  walk(PUBLIC_DIR);
  return max;
}

export function ensureFreshBundle() {
  const srcMtime = newestSourceMtime();
  const manifestMtime = fs.existsSync(MANIFEST_PATH) ? fs.statSync(MANIFEST_PATH).mtimeMs : 0;
  if (manifestMtime >= srcMtime) {
    loadManifest();
    return;
  }
  console.log('[frontend-bundle] sources newer than manifest, rebuilding...');
  const r = spawnSync('node', [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`frontend build failed (exit ${r.status})`);
  loadManifest();
}

// ─── manifest 热加载 ───
let _watching = false;
export function watchManifest() {
  if (_watching) return;
  _watching = true;
  fs.watchFile(MANIFEST_PATH, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      console.log('[frontend-bundle] manifest changed, reloading');
      loadManifest();
    }
  });
}

// ─── index.html 模板化 ───
// 对每个 (srcName → distPath)，把 `src="srcName"` 或 `href="srcName"` 替换为 distPath
export function templateHtml(html) {
  if (!_manifest?.assets) return html;
  for (const [src, dist] of Object.entries(_manifest.assets)) {
    const esc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`((?:src|href)=)"${esc}"`, 'g'), `$1"${dist}"`);
  }
  return html;
}

// ─── 内容协商压缩 variant ───
// 返回 { filePath, encoding }；encoding 为 null 表示原文件
export function pickEncoding(filePath, acceptEncoding = '') {
  if (!_manifest?.encodings?.length) return { filePath, encoding: null };
  const ae = acceptEncoding.toLowerCase();
  // 偏好顺序：brotli > gzip
  const order = [
    { ext: 'br', token: 'br' },
    { ext: 'gz', token: 'gzip' },
  ];
  for (const { ext, token } of order) {
    if (!_manifest.encodings.includes(ext)) continue;
    if (!ae.includes(token)) continue;
    const candidate = `${filePath}.${ext}`;
    if (fs.existsSync(candidate)) return { filePath: candidate, encoding: token };
  }
  return { filePath, encoding: null };
}

// 启动时先尝试读一次（即便没 manifest 也无害）
loadManifest();
