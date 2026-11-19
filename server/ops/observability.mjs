// observability.mjs — in-process counters + histograms + trace ring (no external deps)

const START_TIME = Date.now();

class Observability {
  constructor() {
    this._counters = {};
    this._histograms = {};  // name -> number[]
    this._traces = [];
  }

  counter(name, n = 1) {
    this._counters[name] = (this._counters[name] || 0) + n;
  }

  hist(name, ms) {
    if (!this._histograms[name]) this._histograms[name] = [];
    const arr = this._histograms[name];
    arr.push(ms);
    // Rolling window: keep last 1000 samples
    if (arr.length > 1000) arr.shift();
  }

  recordTrace(event) {
    this._traces.push({ ts: Date.now(), ...event });
    if (this._traces.length > 100) this._traces.shift();
  }

  getMetrics() {
    const histograms = {};
    for (const [name, samples] of Object.entries(this._histograms)) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      const idx99 = Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1);
      histograms[name] = {
        count: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p99: sorted[idx99],
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    return {
      uptime_ms: Date.now() - START_TIME,
      counters: { ...this._counters },
      histograms,
    };
  }

  getTraces(limit = 20) {
    return this._traces.slice(-limit);
  }

  getHealth(deps = {}) {
    return {
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
      deps,
    };
  }
}

export const obs = new Observability();
