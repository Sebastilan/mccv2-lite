// chat-pool.mjs — chat pool 进程入口（BasePool + adapters/chat/chat.mjs 启动器）
//
// 与 src/pools/ling/ling-pool.mjs 角色对称：独立进程，setsid 脱离父进程组，
// 通过 core Unix socket 与 core 双向通信。所有协议封在 BasePool（通用层）+
// adapters/chat（stdio v1 原生实现）。加这种 actor 只用几行胶水。

import path from 'path';
import { fileURLToPath } from 'url';
import { BasePool } from '../_base/pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const argv = process.argv.slice(2);
const idx = argv.indexOf('--core-socket');
const coreSocket = idx !== -1 ? argv[idx + 1] : null;
if (!coreSocket) {
  console.error('[chat-pool] Usage: node chat-pool.mjs --core-socket <path>');
  process.exit(1);
}

const pool = new BasePool({
  kind: 'chat',
  coreSocket,
  dbPath: path.join(ROOT, 'data', 'bus.db'),
  pidFile: path.join(ROOT, 'sockets', 'chat-pool.pid'),
  launcher: {
    command: 'node',
    args: [path.join(ROOT, 'adapters', 'chat', 'chat.mjs')],
  },
});

if (!pool.start()) {
  console.error('[chat-pool] singleton guard tripped, exiting');
  process.exit(0);
}
console.log(`[chat-pool] started pid=${process.pid}, connected to ${coreSocket}`);

process.on('uncaughtException', (err) => {
  console.error('[chat-pool] FATAL uncaughtException:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[chat-pool] FATAL unhandledRejection:', reason?.stack || reason);
  process.exit(1);
});
process.on('SIGTERM', () => { console.log('[chat-pool] SIGTERM, exiting'); pool.stop(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[chat-pool] SIGINT, exiting');  pool.stop(); process.exit(0); });
