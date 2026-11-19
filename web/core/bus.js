// bus.js — 前端事件总线（订阅式，跨 ui/ 组件通信，无 DOM 依赖）

const _listeners = new Map(); // event → Set<fn>

export const bus = {
  on(event, fn) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(fn);
  },
  off(event, fn) {
    _listeners.get(event)?.delete(fn);
  },
  emit(event, ...args) {
    for (const fn of (_listeners.get(event) || [])) {
      try { fn(...args); } catch (e) { console.error('[bus] handler error:', event, e); }
    }
  },
};
