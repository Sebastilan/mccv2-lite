// actor-format.js — Actor/终端展示格式化（shortProject / shortModel / ctxPct / shortCost）

export function shortProject(p) {
  if (!p) return p;
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function shortModel(m, provider) {
  if (!m) return '?';
  if (/opus/i.test(m)) return 'opus';
  if (/sonnet/i.test(m)) return 'sonnet';
  if (/fable/i.test(m)) return 'fable';
  if (/haiku/i.test(m)) return 'haiku';
  if (/deepseek.*v4.*pro/i.test(m)) return 'DeepSeek V4 Pro';
  if (/deepseek.*v4.*flash/i.test(m)) return 'DeepSeek V4 Flash';
  if (/deepseek/i.test(m)) return 'DeepSeek';
  return m.split('-').pop() || m;
}

export function ctxPct(t) {
  const u = t.lastUsage;
  if (!u) return 'ctx —';
  const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const max = t.contextWindow || 1_000_000;
  const pct = Math.round(used / max * 100);
  const cls = pct >= 90 ? 'ctx-critical' : pct >= 75 ? 'ctx-warn' : '';
  return `<span class="${cls}">ctx ${pct}%</span>`;
}

export function shortCost(t) {
  if (!t.totalCost) return '';
  return `$${t.totalCost < 1 ? t.totalCost.toFixed(2) : t.totalCost.toFixed(1)}`;
}

export function shortTokens(t) {
  if (!t.totalTokens) return '';
  const k = t.totalTokens / 1000;
  return k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${k.toFixed(1)}K`;
}
