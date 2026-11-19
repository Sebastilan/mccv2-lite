// manifest.mjs — host provider（本机 Claude，OAuth credentials）
// 纯数据 manifest（Provider Contract v1.2）：available/resolveEnv/passModelFlag/healthCheck
// 均由 registry 按 format+baseUrl 兜底默认（isHost → available 查 credentials.json、resolveEnv {}）。
export default {
  id: 'host',
  name: 'Claude Code（本机登录）',
  format: 'anthropic',  // 业界两种格式之一（见 protocol/provider-contract.md §3.1）
  baseUrl: null,        // null = 走 OAuth credentials，无需设 ANTHROPIC_BASE_URL
  models: ['claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-fable-5-1'],
  envVars: [],
  // 各模型真实上下文窗口（tokens）。经 platform.claude.com/docs/en/models/*/overview 逐个核实
  // （2026-09-24）：Opus 5.5 / Sonnet 5 / Fable 5.1 官方均为 1M 默认，不需要 beta header——
  // 之前把 sonnet-5 错标成 200K（沿用了 Haiku 4.5 的数字），导致 ctx% 显示虚高好几倍。
  // [1m] 后缀是 mccv2/CC 这边历史上给旧款 Opus（需 beta header 才给 1M）留的记账标记，
  // 官方 model ID 其实没有这个后缀，纯粹是本地展示/选择用的别名，不影响真实上下文。
  contextWindows: {
    'claude-opus-5-5[1m]': 1_000_000,
    'claude-sonnet-5': 1_000_000,
    'claude-fable-5-1': 1_000_000,
  },

  // ── verify 记录（由 verify CLI 自动写入，不要手填） ──
  verified: { at: '2026-07-01T00:34:10.259Z', latencyMs: 8067 },
};
