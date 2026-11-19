// _verify.mjs — provider 健康检查执行器：创建临时 actor + 发 ping + 等回复 + 清理
const BASE = `http://localhost:${process.env.MCC_PORT || 47834}`;

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  return res.json();
}

/**
 * verify(manifest) — 真实测试一个 provider 是否正常工作
 * @param {object} manifest - 已加载的 manifest 对象
 * @returns {{ ok: boolean, latencyMs: number, reply: string, error?: string }}
 */
export async function verify(manifest) {
  const { id, healthCheck, resolveEnv } = manifest;
  const { prompt, expectContains = [], timeoutMs = 30000 } = healthCheck ?? {};

  // 1. 构造 actor meta：provider env 直接注入，绕过服务端 resolveProviderEnv
  // model 用 manifest.models[0]（真实模型名）而非 provider id：
  //   ① 语义更正确——测的是真模型；②让服务端 resolveByModel 命中 → 正确传 --model，
  //   这是经 ccr 逗号直路由(如 "zheng,gpt-5.5")的 provider 能被正确路由的前提。
  const providerEnv = resolveEnv?.() ?? {};
  const meta = { model: manifest.models?.[0] ?? id };
  if (Object.keys(providerEnv).length) meta.providerEnv = providerEnv;
  // 显式带上 passModelFlag：process.mjs 让 meta.passModelFlag 优先于 registry 查询，
  // 使未入库(无 verified.at)的新 provider 也能带正确 --model 完成验证。纯数据 manifest
  // 此刻 passModelFlag=undefined（默认下沉到 registry），故取 ?? true。
  meta.passModelFlag = manifest.passModelFlag ?? true;

  // 2. 创建临时 CC actor
  let actorId;
  try {
    const res = await apiFetch('/api/actors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'cc', meta }),
    });
    actorId = res.actorId;
  } catch (e) {
    return { ok: false, latencyMs: 0, reply: '', error: `create actor failed: ${e.message}` };
  }

  // 3. 发 ping 消息
  const sendAt = Date.now();
  try {
    await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_id: actorId, kind: 'text', payload: { text: prompt } }),
    });
  } catch (e) {
    await _cleanup(actorId);
    return { ok: false, latencyMs: 0, reply: '', error: `send message failed: ${e.message}` };
  }

  // 4. 轮询等待 CC 回复（kind='text', from_id=actorId）
  const deadline = sendAt + timeoutMs;
  let lastSince = 0;
  let reply = '';

  while (Date.now() < deadline) {
    await _sleep(1000);
    try {
      const msgs = await apiFetch(`/api/actors/${actorId}/messages?since=${lastSince}`);
      for (const m of msgs) {
        if (m.from_id === actorId && m.kind === 'text') {
          const payload = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload;
          reply = payload?.text ?? '';
          break;
        }
        if (m.id > lastSince) lastSince = m.id;
      }
      if (reply) break;
      if (msgs.length) lastSince = msgs[msgs.length - 1].id;
    } catch (e) {
      // transient poll error, continue
    }
  }

  const latencyMs = Date.now() - sendAt;

  // 5. 清理 actor
  await _cleanup(actorId);

  // 6. 检查回复
  if (!reply) return { ok: false, latencyMs, reply: '', error: 'timeout: no reply' };
  const replyLower = reply.toLowerCase();
  const allMatch = expectContains.every(w => replyLower.includes(w.toLowerCase()));
  if (!allMatch) {
    return { ok: false, latencyMs, reply, error: `reply "${reply}" missing expected words: ${expectContains.join(', ')}` };
  }
  return { ok: true, latencyMs, reply };
}

async function _cleanup(actorId) {
  try {
    await apiFetch(`/api/actors/${actorId}`, { method: 'DELETE' });
  } catch (e) {
    console.warn(`[verify] cleanup actor ${actorId} failed:`, e.message);
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
