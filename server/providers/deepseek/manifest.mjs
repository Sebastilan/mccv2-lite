// manifest.mjs — deepseek provider（DeepSeek Anthropic-compat endpoint）
// 纯数据 manifest（Provider Contract v1.2）：available/resolveEnv 由 registry 兜底
// （anthropic 第三方 → available 查 envVars 任一在、resolveEnv 注 baseUrl + 第一个在的 key）。
export default {
  id: 'deepseek',
  name: 'DeepSeek',
  format: 'anthropic',  // 业界两种格式之一（见 protocol/provider-contract.md §3.1）
  baseUrl: 'https://api.deepseek.com/anthropic',  // Anthropic-compat endpoint
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  envVars: ['PROVIDER_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'],  // 任一在即用第一个在的
  // 官方 API 文档确认两款模型 Anthropic-compat endpoint 与原生同规格，均 1M 上下文
  // （api-docs.deepseek.com；同类 CC 客户端误判见 github.com/anthropics/claude-code/issues/46416：
  // 非 api.anthropic.com 的 base_url 一律探测失败退化到 200k 默认值）。
  contextWindows: { 'deepseek-v4-pro': 1_000_000, 'deepseek-v4-flash': 1_000_000 },

  // ── verify 记录（由 verify CLI 自动写入，不要手填） ──
  verified: { at: '2026-07-01T00:33:56.795Z', latencyMs: 10063 },
};
