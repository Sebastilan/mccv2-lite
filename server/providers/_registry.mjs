// _registry.mjs — provider 注册中心：扫描 server/providers/*/manifest.mjs，自动注册
import { readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _providers = [];

// 本地 anthropic↔openai 翻译 proxy（claude-code-router :3100）
const OPENAI_PROXY = 'http://127.0.0.1:3100';
// host = anthropic 格式且无 baseUrl（走 OAuth credentials）
const isHost = m => m.format === 'anthropic' && !m.baseUrl;

// withDefaults — 按 format+baseUrl+envVars 兜底默认行为，manifest 已定义则不覆盖。
// 让纯数据 manifest（无函数体）也能被正确解析（Provider Contract v1.2）。
// 导出供 verify 侧对未入库 provider 应用同一套默认（否则 raw manifest 无 resolveEnv/available）。
export function withDefaults(m) {
  return {
    ...m,
    passModelFlag: m.passModelFlag ?? true,
    available: m.available ?? (() => {
      if (isHost(m)) return existsSync(`${os.homedir()}/.claude/.credentials.json`);
      if (m.format === 'openai') return true;                    // 翻译 proxy 常驻
      return (m.envVars ?? []).some(k => process.env[k]);        // anthropic 第三方：任一 env 在即可
    }),
    resolveEnv: m.resolveEnv ?? (() => {
      if (isHost(m)) return {};                                  // OAuth credentials，无需注 env
      if (m.format === 'openai')
        return {
          ANTHROPIC_BASE_URL: OPENAI_PROXY,
          ANTHROPIC_API_KEY: (m.envVars ?? []).map(k => process.env[k]).find(Boolean) ?? `${m.id}-proxy-local`,
        };
      const key = (m.envVars ?? []).map(k => process.env[k]).find(Boolean);   // anthropic 第三方
      return { ANTHROPIC_BASE_URL: m.baseUrl, ANTHROPIC_API_KEY: key };
    }),
    healthCheck: m.healthCheck ?? { prompt: 'reply pong in one word', expectContains: ['pong'], timeoutMs: 30000 },
  };
}

async function _scan() {
  const skipVerify = process.env.SKIP_VERIFY === '1';
  const entries = readdirSync(__dirname, { withFileTypes: true });
  // Sort: host first (matches original getProviders order), then alphabetically
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('_'))
    .map(e => e.name)
    .sort((a, b) => (a === 'host' ? -1 : b === 'host' ? 1 : a.localeCompare(b)));

  const loaded = [];
  for (const dir of dirs) {
    const manifestPath = path.join(__dirname, dir, 'manifest.mjs');
    if (!existsSync(manifestPath)) continue;
    try {
      const mod = await import(manifestPath);
      const raw = mod.default;
      if (!raw?.id) { console.warn(`[registry] ${dir}/manifest.mjs missing id, skipped`); continue; }
      const manifest = withDefaults(raw);   // 纯数据 manifest 补默认行为
      if (!manifest.available()) continue;
      if (!skipVerify && !manifest.verified?.at) continue;
      loaded.push(manifest);
    } catch (e) {
      console.warn(`[registry] failed to load ${dir}/manifest.mjs:`, e.message);
    }
  }
  _providers = loaded;
}

// Auto-scan on module load (top-level await, ESM only)
await _scan();

// getAll — 返回 provider 元数据数组（用于 /api/providers）
export function getAll() {
  return _providers.map(p => ({
    id: p.id,
    name: p.name,
    models: p.models ?? [],
    available: typeof p.available === 'function' ? p.available() : true,
  }));
}

// resolveByModel — 按具体模型名查 provider（meta.model 存的是模型名，非 provider ID）
// 返回 { providerEnv, passFlag }；未匹配返回 {}
//
// CLAUDE_CODE_MAX_CONTEXT_TOKENS 注入：CC CLI 走 ANTHROPIC_BASE_URL 打非官方 model 名时
// 认不出该模型、本地预检退化成偏保守的默认窗口，会在真实用量远没到位时误判 "Prompt is too
// long" 直接本地拒发（社区通病，见 github.com/anthropics/claude-code/issues/68522；
// 官方文档化解药就是这个 env）。凡 manifest.contextWindows 登记了该模型的真实窗口，
// 一律注入，让 CC 本地预检用真数字，不用瞎猜。
export function resolveByModel(modelName) {
  if (!modelName) return {};
  const provider = _providers.find(p => (p.models ?? []).includes(modelName));
  if (!provider) return {};
  const providerEnv = { ...(provider.resolveEnv?.() ?? {}) };
  const ctxWindow = provider.contextWindows?.[modelName];
  if (ctxWindow) providerEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctxWindow);
  return {
    providerEnv,
    passFlag: provider.passModelFlag ?? false,
  };
}

// resolveContextWindow — 按模型名查 manifest.contextWindows 里登记的真实窗口（tokens）。
// 未登记（manifest 没填该模型，或模型本身未匹配到任何 provider）时返回 null，
// 调用方兜底 1_000_000——不在这里悄悄兜底，免得"查不到"和"真是 1M"混在一起看不出差别。
export function resolveContextWindow(modelName) {
  if (!modelName) return null;
  const provider = _providers.find(p => (p.models ?? []).includes(modelName));
  return provider?.contextWindows?.[modelName] ?? null;
}
