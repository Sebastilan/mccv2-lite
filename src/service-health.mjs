// service-health.mjs — 主线服务健康状态（in-memory Map + 持久化 plugin-health.json）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_FILE = path.join(ROOT, 'data', 'plugin-health.json');

// 只存 yellow 条目；green = 从 map 删除（收敛语义）
const _services = new Map();
let _plugins = {};  // 前端 canvas POST 的 plugins 快照

function _compute() {
  const services = {};
  for (const [name, v] of _services) services[name] = v;
  const anyServiceYellow = _services.size > 0;
  const anyPluginYellow = Object.values(_plugins).some(v => v.state === 'yellow');
  const aggregate = (anyServiceYellow || anyPluginYellow) ? 'yellow' : 'green';
  return { aggregate, plugins: _plugins, services, ts: Date.now() };
}

function _flush() {
  const snap = _compute();
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(snap, null, 2), 'utf-8');
  } catch (e) {
    console.error('[service-health] write failed:', e.message);
  }
}

/**
 * 上报主线服务健康状态。
 * state='green' → 从 map 删除（健康服务不出现在 snapshot）
 * state='yellow' → 写入 map
 */
export function report(name, state, message = '') {
  if (state === 'green') {
    _services.delete(name);
  } else {
    _services.set(name, { state, message, ts: Date.now() });
  }
  _flush();
}

/** 前端 canvas POST 时调，更新 plugins 快照并重写文件。 */
export function setPluginsFromFrontend(plugins) {
  _plugins = plugins || {};
  _flush();
}

/** 返回当前完整健康快照（GET /api/plugins/health 调）。 */
export function getSnapshot() {
  return _compute();
}
