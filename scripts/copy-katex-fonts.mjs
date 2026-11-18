// copy-katex-fonts.mjs — 安装时把 KaTeX 字体从 npm 包拷到前端(字体是二进制,不随源码仓)
//
// 由 npm install 的 postinstall 调用;来源 node_modules/katex/dist/fonts(版本锁在 package.json)。
// 用法：node scripts/copy-katex-fonts.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'src/public/lib/fonts');

const require = createRequire(import.meta.url);
let src;
try {
  src = path.join(path.dirname(require.resolve('katex/package.json')), 'dist/fonts');
} catch {
  console.error('[copy-katex-fonts] 找不到 katex 包:先 npm install');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(DEST, f));
  n++;
}
console.log(`[copy-katex-fonts] ${n} 个字体 → src/public/lib/fonts`);