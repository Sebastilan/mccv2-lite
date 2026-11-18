// main.mjs — 启动入口（Bus → Broadcaster → PoolRegistry → Notify → HTTP/WS server）
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync } from 'fs';
import { Bus } from './bus.mjs';
import { Broadcaster } from './broadcast.mjs';
import { startNotifyServer } from './notify-server.mjs';
import { createServer } from './server.mjs';
import { ensureFreshBundle } from './frontend-bundle.mjs';
import { PoolRegistry } from './pool-registry.mjs';
import { report as reportHealth } from './service-health.mjs';
import { attachWorkerCallback } from './policy/worker-callback.mjs';
import { attachOrphanWorker } from './policy/orphan-worker.mjs';
import { startInboxSweeper } from './pools/cc/inbox.mjs';
import { attachEventStream } from './api-events.mjs';
import { upsertSlot } from './api/pin-slots.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DB_PATH = path.join(ROOT, 'data', 'bus.db');
const SOCKET_PATH = path.join(ROOT, 'sockets', 'core.sock');
const POOL_PID_FILE = path.join(ROOT, 'sockets', 'cc-pool.pid');
const PORT = Number(process.env.MCC_PORT || 47834);
const LOG_DIR = path.join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

/** Open a log file in append mode for detached child stdio (避免继承父进程 stdout 导致 SIGPIPE 连锁死亡). */
function openLogFd(name) {
  return openSync(path.join(LOG_DIR, `${name}.log`), 'a');
}

const t0 = Date.now();

mkdirSync(path.join(ROOT, 'data'), { recursive: true });
mkdirSync(path.join(ROOT, 'sockets'), { recursive: true });

// MCP config 给 CC spawn 用（--mcp-config 指向它）
// 这里是所有 MCC 起的 CC 终端 MCP 工具的唯一来源(strict-mcp-config);data/mcp-config.json 启动时覆盖。
const MCP_CONFIG_PATH = path.join(ROOT, 'data', 'mcp-config.json');
// 内置两把 MCP：ask_user(向人提问)与 actor(终端间互发消息)。
const LOCAL_MCP = {
  // mcc: ask_user — 替代被禁用的 AskUserQuestion
  mcc: {
    command: 'node',
    args: [path.join(ROOT, 'src', 'pools', 'cc', 'mcp-ask-server.mjs')],
  },
  // actor: actor-to-actor 通讯基建（send_message / read_messages）—— @ mention 的底层
  actor: {
    command: 'node',
    args: [path.join(ROOT, 'src', 'pools', 'cc', 'mcp-actor-server.mjs')],
  },
};
writeFileSync(MCP_CONFIG_PATH, JSON.stringify({
  mcpServers: { ...LOCAL_MCP },
}, null, 2));
process.env.MCC_MCP_CONFIG = MCP_CONFIG_PATH;

const bus = new Bus(DB_PATH);
bus.applyMigrations();
bus.markStaleActorsGone(30_000);

const broadcaster = new Broadcaster(bus);
bus.setBroadcaster(broadcaster);

const poolSupervisor = new PoolRegistry(bus);
// 注册 cc pool（actor-stdio v1 迁移期：cc-pool.mjs 仍走旧 stream-json 接入，等价行为）
poolSupervisor.register('cc', {
  scriptPath: path.join(ROOT, 'src', 'pools', 'cc', 'cc-pool.mjs'),
  pidFile: POOL_PID_FILE,
});
// 注册 chat pool（「慢聊」，stdio v1 原生）
poolSupervisor.register('chat', {
  scriptPath: path.join(ROOT, 'src', 'pools', 'chat', 'chat-pool.mjs'),
  pidFile: path.join(ROOT, 'sockets', 'chat-pool.pid'),
});
broadcaster.setPoolSupervisor(poolSupervisor);

// 「慢聊」pin 槽位：chat 是 mccv2 一等公民，开机幂等 seed 一张常驻占位卡。
// 无 actor 时渲染 ghost 占位卡，点击即按 spawnMeta 创建；slotId+pinTop 让它落在 .pinned-row。
// slotId 唯一占位天然保证单例（占了就不再出 ghost），无需前端 singleton 去重。
upsertSlot('slowchat', '慢聊', {
  kind: 'chat',
  // model 显式写进 spawnMeta：ghost 卡点击建出来的慢聊直接是这一档，
  // 不依赖后端 createChatActor 的兜底默认（改默认时两处一起改）
  meta: { name: '慢聊', slotId: 'slowchat', pinTop: true, model: 'deepseek-v4-flash' },
});

// advisor/worker policy: worker busy→idle 通知 advisor + idle 45min 自动回收（保活复用）
attachWorkerCallback(bus, poolSupervisor, broadcaster);
// advisor→workers 级联：advisor gone 时关闭其名下所有 worker
attachOrphanWorker(bus, poolSupervisor, broadcaster);

startNotifyServer(SOCKET_PATH, bus, broadcaster, {
  onPoolConnected: (conn, kind) => poolSupervisor.onPoolConnected(conn, kind),
});

setInterval(() => broadcaster.pollMissed(), 500);

// SSE 通知端点 /api/events 的事件源装配（挂 bus 'actor_status' + 消息游标/心跳定时器）
attachEventStream(bus);

// 用户发给 CC 的附件 inbox 自动清理（48h TTL，每小时扫一次）
startInboxSweeper();

// 前端 bundle 门控：src/public 新于 manifest 即同步重建（避免改了源码忘 build）
ensureFreshBundle();

const server = createServer({ port: PORT, bus, broadcaster, poolSupervisor });

server.on('listening', () => {
  const ms = Date.now() - t0;
  console.log(`[main] ready in ${ms}ms`);
  reportHealth('mccv2-core', 'green', `ready in ${ms}ms`);
  // spawnAll 内部按 pool 检查 PID 文件，存活则跳过（pool 自己重连）
  poolSupervisor.spawnAll(SOCKET_PATH);
});

setInterval(() => bus.markStaleActorsGone(30_000), 10_000);
