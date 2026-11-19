// life-pool.mjs — life pool 进程入口（BasePool + life.mjs 启动器，傻循环）
//
// 与 terminals/chat/chat-pool.mjs 角色对称：独立进程，setsid 脱离父进程组，
// 通过 core Unix socket 与 core 双向通信。所有协议封在 BasePool（通用层）+
// life.mjs（stdio v1 原生实现）。加这种 actor 只用几行胶水。

import path from 'path';
import { fileURLToPath } from 'url';
import { BasePool } from '../_base/pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const argv = process.argv.slice(2);
const idx = argv.indexOf('--core-socket');
const coreSocket = idx !== -1 ? argv[idx + 1] : null;
if (!coreSocket) {
  console.error('[life-pool] Usage: node life-pool.mjs --core-socket <path>');
  process.exit(1);
}

const pool = new BasePool({
  kind: 'life',
  coreSocket,
  dbPath: path.join(ROOT, 'data', 'bus.db'),
  pidFile: path.join(ROOT, 'sockets', 'life-pool.pid'),
  launcher: {
    command: 'node',
    args: [path.join(__dirname, 'life.mjs')],
  },
});

if (!pool.start()) {
  console.error('[life-pool] singleton guard tripped, exiting');
  process.exit(0);
}
console.log(`[life-pool] started pid=${process.pid}, connected to ${coreSocket}`);

process.on('uncaughtException', (err) => {
  console.error('[life-pool] FATAL uncaughtException:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[life-pool] FATAL unhandledRejection:', reason?.stack || reason);
  process.exit(1);
});
process.on('SIGTERM', () => { console.log('[life-pool] SIGTERM, exiting'); pool.stop(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[life-pool] SIGINT, exiting');  pool.stop(); process.exit(0); });
