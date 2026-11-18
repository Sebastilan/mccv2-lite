#!/usr/bin/env node
// mcp-actor-server.mjs — actor-to-actor 通讯基建（三个工具：send_message / read_messages / interrupt）
// 由 CC CLI 通过 --mcp-config 拉起；从 env MCC_ACTOR_ID 拿到当前 actor 身份；
// HTTP 调 core /api/actor-bus/{send,messages}。权限全开，由 env 注入担保身份。
import readline from 'readline';
import http from 'http';

const CORE_PORT = parseInt(process.env.MCC_CORE_PORT || '47834', 10);
const ACTOR_ID  = process.env.MCC_ACTOR_ID || '';
const PROTOCOL_VERSION = '2024-11-05';

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

const TOOLS = [
  {
    name: 'send_message',
    description: '给另一个 actor 发送一条文本消息。用于 actor 间协作（@ mention 的底层、advisor↔worker 通讯、跨终端协调）。消息以当前 actor 身份发出（from = 当前 actor）。注意：对方正在 busy 时消息只会排队，等它当前这一轮整个跑完才被读到——要立刻改掉它正在做的事，先用 interrupt 叫停，再发一条改后的完整任务。',
    inputSchema: {
      type: 'object',
      properties: {
        actor_id: { type: 'string', description: '目标 actor 的 id（如 cc_1747900000000）' },
        text:     { type: 'string', description: '消息正文（纯文本）' },
      },
      required: ['actor_id', 'text'],
    },
  },
  {
    name: 'read_messages',
    description: '读取某个 actor 的纯文本消息历史（双向，含其收到的和发出的）。用于查看其他终端的近况、判断它是否卡住、了解对方上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        actor_id: { type: 'string', description: '要读取的 actor id' },
        limit:    { type: 'integer', description: '返回最近多少条（默认 20，最多 200）', default: 20 },
      },
      required: ['actor_id'],
    },
  },
  {
    name: 'interrupt',
    description: '叫停另一个 actor 正在跑的这一轮（典型场景：派给 worker 的活派错了/要改，而它已经开跑）。'
      + '只中止当前 turn，不杀终端——进程和会话都保留，对方立刻回到 idle，下一条消息接着聊。'
      + '派错了要改派：先 interrupt，再 send_message 发一条【改后的完整任务】（不是补一句）。'
      + '只发消息不 interrupt 改不了正在跑的那一轮；busy 时连发多条不会丢，但每条各起一轮，'
      + '中间那条已作废的照样会被完整执行一遍。任务做完不再需要该 worker 用 DELETE /api/actors/<id>，不是本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        actor_id: { type: 'string', description: '要叫停的 actor id' },
      },
      required: ['actor_id'],
    },
  },
];

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: CORE_PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf-8');
        try {
          const obj = JSON.parse(txt);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(obj);
          else reject(new Error(`HTTP ${res.statusCode}: ${obj.error || txt}`));
        } catch (e) { reject(new Error(`bad JSON from core: ${txt.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function handleSend(id, args) {
  const target = String(args.actor_id || '').trim();
  const text   = String(args.text || '');
  if (!target || !text) return fail(id, -32602, 'actor_id and text required');
  if (!ACTOR_ID) return fail(id, -32603, 'MCC_ACTOR_ID env missing — cannot identify sender');
  try {
    const r = await httpJson('POST', '/api/actor-bus/send', { from_id: ACTOR_ID, to_id: target, text });
    reply(id, {
      content: [{ type: 'text', text: `已发送（msg id=${r.id}）给 ${target}` }],
      isError: false,
    });
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: `send_message failed: ${e.message}` }], isError: true });
  }
}

async function handleRead(id, args) {
  const target = String(args.actor_id || '').trim();
  const limit  = Math.min(Number(args.limit || 20), 200);
  if (!target) return fail(id, -32602, 'actor_id required');
  try {
    const r = await httpJson('GET', `/api/actor-bus/messages?actor=${encodeURIComponent(target)}&limit=${limit}`);
    const msgs = r.messages || [];
    const lines = msgs.map(m => {
      const t = new Date(m.ts).toISOString().slice(11, 19);
      const dir = m.from_id === target ? '→' : '←';  // → 表示该 actor 发出，← 表示收到
      const peer = m.from_id === target ? m.to_id : m.from_id;
      return `[${t}] ${dir} ${peer}: ${m.text}`;
    });
    const header = `# ${target} 最近 ${msgs.length} 条消息（→ 发出 / ← 收到）\n`;
    reply(id, {
      content: [{ type: 'text', text: header + (lines.join('\n') || '(无消息)') }],
      isError: false,
    });
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: `read_messages failed: ${e.message}` }], isError: true });
  }
}

async function handleInterrupt(id, args) {
  const target = String(args.actor_id || '').trim();
  if (!target) return fail(id, -32602, 'actor_id required');
  try {
    // 先读状态：idle 的终端没有正在跑的 turn，打断是空操作——如实告诉调用方，
    // 免得它以为叫停成功、转头就发新任务却排在旧任务后面。
    let wasBusy = null;
    try {
      const a = await httpJson('GET', `/api/actors/${encodeURIComponent(target)}`);
      wasBusy = (a?.status ?? a?.actor?.status) === 'busy';
    } catch { /* 读不到状态不阻断打断本身 */ }
    await httpJson('POST', `/api/actors/${encodeURIComponent(target)}/interrupt`);
    const tail = wasBusy === false
      ? `（它当时是 idle，没有正在跑的 turn，这次打断是空操作）`
      : `（本轮已中止，进程和会话都保留；改派请再发一条完整的新任务）`;
    reply(id, { content: [{ type: 'text', text: `已叫停 ${target}${tail}` }], isError: false });
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: `interrupt failed: ${e.message}` }], isError: true });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'mcc-actor', version: '0.1.0' },
    });
  } else if (method === 'notifications/initialized') {
    // notification, no response
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'send_message') handleSend(id, args);
    else if (name === 'read_messages') handleRead(id, args);
    else if (name === 'interrupt') handleInterrupt(id, args);
    else fail(id, -32601, `unknown tool: ${name}`);
  } else if (id != null) {
    fail(id, -32601, `method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
