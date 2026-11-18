// build-frontend.mjs — 写侧：把 src/public/{app.js, style.css} 打包为带 hash 的 dist
//
// 输出（每个资源 5 个文件）：
//   dist/app.<hash>.js   + .br + .gz + .map
//   dist/style.<hash>.css + .br + .gz + .map
//   dist/manifest.json   契约文件，给 src/frontend-bundle.mjs 读
//
// 用法：node scripts/build-frontend.mjs [--watch]

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src/public');
const DIST = path.join(PUBLIC, 'dist');

// esbuild config：entry 对象形式，key 即输出 basename
const ctx = {
  entryPoints: {
    'app': path.join(PUBLIC, 'app.js'),
    'style': path.join(PUBLIC, 'style.css'),
  },
  bundle: true,
  format: 'esm',
  splitting: false,
  minify: true,
  sourcemap: true,
  target: 'es2019',
  outdir: DIST,
  entryNames: '[name].[hash]',
  metafile: true,
  logLevel: 'info',
};

// 为每个产物写 .br + .gz 兄弟（brotli 最高质量 11，gzip level 9，离线代价高在线 0）
function precompress(filePath) {
  const buf = fs.readFileSync(filePath);
  fs.writeFileSync(filePath + '.br', zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }));
  fs.writeFileSync(filePath + '.gz', zlib.gzipSync(buf, { level: 9 }));
}

// 从 metafile.outputs 反推 (srcName → distPath) 映射
//   outputs key 形如 "src/public/dist/app.HLQXICQJ.js"
//   srcName = basename split 第一段 + ext  →  "app.js"
function buildAssetMap(metafile) {
  const assets = {};
  for (const out of Object.keys(metafile.outputs)) {
    if (out.endsWith('.map')) continue;
    const baseName = path.basename(out);       // app.HASH.js
    const ext = path.extname(baseName);        // .js
    const srcName = baseName.split('.')[0] + ext;  // app.js
    assets[srcName] = `dist/${baseName}`;
  }
  return assets;
}

function writeManifest(metafile) {
  const assets = buildAssetMap(metafile);
  const manifest = {
    version: 2,
    assets,
    encodings: ['br', 'gz'],
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[build] assets: ${JSON.stringify(assets)}`);
}

function precompressAll(metafile) {
  for (const out of Object.keys(metafile.outputs)) {
    if (!out.endsWith('.map')) precompress(out);
  }
}

async function runOnce() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const result = await esbuild.build(ctx);
  precompressAll(result.metafile);
  writeManifest(result.metafile);
}

if (process.argv.includes('--watch')) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const c = await esbuild.context(ctx);
  const r = await c.rebuild();
  precompressAll(r.metafile);
  writeManifest(r.metafile);
  await c.watch();
  console.log('[build] watching... (注意：watch 模式下增量 rebuild 不会自动重压缩+重写 manifest，重新跑命令以刷新)');
} else {
  await runOnce();
}
