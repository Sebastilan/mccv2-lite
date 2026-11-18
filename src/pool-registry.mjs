// pool-registry.mjs — 多 pool 注册表（每种 actor kind 一个 Pool 实例）
//
// 取代旧 pool-supervisor.mjs。设计差别：
//   - 旧：单数 poolConn，硬假设只有 cc-pool 一种
//   - 新：Map<kind, Pool>，加 pool = registry.register(kind, ...) 一行，零摩擦
//
// 路由：notifyNewMessage(actorId) 按 actor.kind 查表派发；不匹配的（人类 actor）no-op。
// public API 保留 spawnAll/restartPool(kind)/notifyNewMessage/notifyNewActor/stopActor/
// onPoolConnected(conn, kind)，callers 不动。

import { spawn } from 'child_process';
import { mkdirSync, openSync, existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { obs } from './observability.mjs';
import { report as reportHealth } from './service-health.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

class Pool {
  constructor(kind, opts) {
    this.kind = kind;
    this.scriptPath = opts.scriptPath;
    this.pidFile = opts.pidFile;
    this.env = opts.env || {};
    this.conn = null;
    this.coreSockPath = null;
  }

  // detached spawn（同 cc-pool 模式）：日志写文件而非继承父 stdio，避免 systemd 重启
  // 父进程时继承的 pipe 对端断开触发 SIGPIPE 自杀
  spawn(coreSockPath) {
    this.coreSockPath = coreSockPath;
    const fd = openSync(path.join(LOG_DIR, `${this.kind}-pool.log`), 'a');
    const child = spawn('node', [this.scriptPath, '--core-socket', coreSockPath], {
      stdio: ['ignore', fd, fd],
      detached: true,
      env: { ...process.env, ...this.env },
    });
    child.unref();
    console.log(`[pool-registry] spawned ${this.kind}-pool (pid=${child.pid})`);
    return child.pid;
  }

  // 进程组 SIGTERM（负 PID 杀整个 setsid 组：pool + 所有 actor 子进程）
  async restart() {
    if (!this.coreSockPath) {
      throw new Error(`${this.kind}-pool: coreSockPath not recorded — spawn() never called`);
    }
    let oldPid = null;
    if (existsSync(this.pidFile)) {
      try { oldPid = parseInt(readFileSync(this.pidFile, 'utf-8').trim()) || null; } catch {}
    }
    if (oldPid) {
      try {
        process.kill(-oldPid, 'SIGTERM');
        console.log(`[pool-registry] sent SIGTERM to ${this.kind}-pool group ${oldPid}`);
      } catch (e) {
        console.warn(`[pool-registry] kill pgid ${oldPid} failed: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(this.pidFile)) {
      try { unlinkSync(this.pidFile); } catch {}
    }
    const newPid = this.spawn(this.coreSockPath);
    return { oldPid, newPid };
  }

  // 跨 core 重启活下来的检测：core 重启时若 pool 仍在跑，跳过 spawn 让其自动重连
  //
  // ⚠️ 只看 process.kill(pid,0) 不够：pool 死后 pid 文件残留，PID 被系统回收给别的进程后
  // 会误判「还活着」→ 永久不 spawn（而且 restart() 会 SIGTERM 无辜进程组）。
  // 必须再核对 /proc/<pid>/cmdline 里确实是本 pool 的脚本。
  isAlive() {
    if (!existsSync(this.pidFile)) return false;
    try {
      const pid = parseInt(readFileSync(this.pidFile, 'utf-8').trim());
      if (!pid) return false;
      process.kill(pid, 0);  // throws if process doesn't exist
      // 认脚本文件名而非全路径：registry 自己 spawn 用绝对路径，手工拉起可能是相对路径
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' ');
      if (!cmdline.includes(path.basename(this.scriptPath))) {
        console.warn(`[pool-registry] ${this.kind}-pool pid ${pid} 已被回收给别的进程，忽略陈旧 pid 文件`);
        try { unlinkSync(this.pidFile); } catch {}
        return false;
      }
      return true;
    } catch { return false; }
  }

  attach(conn) {
    this.conn = conn;
    obs.recordTrace({ type: 'pool_connected', kind: this.kind });
    reportHealth(`${this.kind}-pool`, 'green');
    conn.on('close', () => {
      if (this.conn !== conn) return;  // 已被更新的连接替换，这条是旧连接迟到的 close，不能覆盖新连接的健康状态
      this.conn = null;
      obs.recordTrace({ type: 'pool_disconnected', kind: this.kind });
      reportHealth(`${this.kind}-pool`, 'yellow', 'connection closed');
      console.error(`[pool-registry] ${this.kind}-pool connection closed — 查 journal 找退出原因`);
    });
  }

  send(msg) {
    if (this.conn && !this.conn.destroyed) {
      this.conn.write(JSON.stringify(msg) + '\n');
      return true;
    }
    reportHealth(`${this.kind}-pool`, 'yellow', `dropped: ${msg.event}`);
    console.warn(`[pool-registry] ${this.kind}-pool not connected, dropped:`, msg.event, msg.actorId || '');
    return false;
  }
}

export class PoolRegistry {
  constructor(bus) {
    this.bus = bus;
    this.pools = new Map();  // kind → Pool
  }

  /** Register a pool kind at startup (before spawnAll). */
  register(kind, opts) {
    if (this.pools.has(kind)) throw new Error(`pool ${kind} already registered`);
    this.pools.set(kind, new Pool(kind, opts));
  }

  /** Called by notify-server when a pool child sends register_pool. */
  onPoolConnected(conn, kind) {
    const pool = this.pools.get(kind);
    if (!pool) {
      console.warn(`[pool-registry] unknown pool kind=${kind}, dropping connection`);
      try { conn.end(); } catch {}
      return;
    }
    pool.attach(conn);
  }

  /** Spawn all registered pool child processes. Skip any that survived a core restart. */
  spawnAll(coreSockPath) {
    for (const [kind, pool] of this.pools) {
      if (pool.isAlive()) {
        pool.coreSockPath = coreSockPath;  // 没走 spawn() 也要记下，否则 restartPool 抛错
        console.log(`[pool-registry] ${kind}-pool already alive, skipping spawn`);
      } else {
        pool.spawn(coreSockPath);
      }
    }
  }

  /** Restart a specific pool. Default 'cc' for v1 compat（旧 api-compat 端点）. */
  async restartPool(kind = 'cc') {
    const pool = this.pools.get(kind);
    if (!pool) throw new Error(`no pool registered for kind=${kind}`);
    return pool.restart();
  }

  // ── 路由（按 actor.kind 查表）─────────────────────────────────────────────
  _route(actorId, fn) {
    const row = this.bus.db.prepare('SELECT kind FROM actors WHERE id=?').get(actorId);
    if (!row) return false;
    const pool = this.pools.get(row.kind);
    if (!pool) return false;
    fn(pool);
    return true;
  }

  notifyNewMessage(actorId) {
    this._route(actorId, p => p.send({ event: 'new_message', actorId }));
  }

  notifyNewActor(actor) {
    const pool = this.pools.get(actor.kind);
    if (!pool) return;  // 非 pool 管的 kind（如 human）no-op
    pool.send({ event: 'new_actor', actor });
  }

  stopActor(actorId) {
    this._route(actorId, p => p.send({ event: 'stop_actor', actorId }));
  }
}
