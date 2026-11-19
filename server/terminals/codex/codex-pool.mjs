// codex-pool.mjs — codex pool 进程入口（BasePool + codex.mjs 启动器）
//
// 与 terminals/chat/chat-pool.mjs 角色对称：独立进程，setsid 脱离父进程组，
// 通过 core Unix socket 与 core 双向通信。所有协议封在 BasePool（通用层）+
// codex.mjs（stdio v1 原生实现）。加这种 actor 只用几行胶水。

import path from 'path';
import { fileURLToPath } from 'url';
import { BasePool } from '../_base/pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const argv = process.argv.slice(2);
const idx = argv.indexOf('--core-socket');
const coreSocket = idx !== -1 ? argv[idx + 1] : null;
if (!coreSocket) {
  console.error('[codex-pool] Usage: node codex-pool.mjs --core-socket <path>');
  process.exit(1);
}

const pool = new BasePool({
  kind: 'codex',
  coreSocket,
  dbPath: path.join(ROOT, 'data', 'bus.db'),
  pidFile: path.join(ROOT, 'sockets', 'codex-pool.pid'),
  launcher: {
    command: 'node',
    args: [path.join(__dirname, 'codex.mjs')],
  },
});

if (!pool.start()) {
  console.error('[codex-pool] singleton guard tripped, exiting');
  process.exit(0);
}
console.log(`[codex-pool] started pid=${process.pid}, connected to ${coreSocket}`);

process.on('uncaughtException', (err) => {
  console.error('[codex-pool] FATAL uncaughtException:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[codex-pool] FATAL unhandledRejection:', reason?.stack || reason);
  process.exit(1);
});
process.on('SIGTERM', () => { console.log('[codex-pool] SIGTERM, exiting'); pool.stop(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[codex-pool] SIGINT, exiting');  pool.stop(); process.exit(0); });
