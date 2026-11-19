#!/usr/bin/env node
// mcp-ask-server.mjs — stdio MCP server exposing ask_user tool that blocks until human answers
// 由 CC CLI 通过 --mcp-config 拉起；从 env MCC_ACTOR_ID 拿到当前 actor；HTTP long-poll 到 core /api/ask
import readline from 'readline';
import http from 'http';

const CORE_PORT = parseInt(process.env.MCC_CORE_PORT || '47834', 10);
const ACTOR_ID  = process.env.MCC_ACTOR_ID || '';
const PROTOCOL_VERSION = '2024-11-05';

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}
function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [{
  name: 'ask_user',
  description: '向人类用户提问并阻塞等待回答（替代内置 AskUserQuestion，在非交互模式下也能真正等待）。当你需要用户做选择、确认或提供决策时调用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '一组问题（一般 1 个）。每个问题包含 question 文本、header 短标签、options 选项数组、是否多选。',
        items: {
          type: 'object',
          properties: {
            question:    { type: 'string', description: '完整问题文本' },
            header:      { type: 'string', description: '<=12 字的短标签' },
            multiSelect: { type: 'boolean', default: false },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
}];

function postAsk(questions) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ actorId: ACTOR_ID, questions });
    const req = http.request({
      host: '127.0.0.1', port: CORE_PORT, path: '/api/ask', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 0,
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`/api/ask HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function handleToolCall(id, params) {
  const name = params?.name;
  if (name !== 'ask_user') return fail(id, -32601, `unknown tool: ${name}`);
  const args = params?.arguments || {};
  const questions = args.questions || [];
  if (!Array.isArray(questions) || !questions.length) {
    return fail(id, -32602, 'questions[] required');
  }
  try {
    const { answers } = await postAsk(questions);
    const text = Array.isArray(answers)
      ? answers.map((a, i) => `Q${i + 1}: ${a}`).join('\n')
      : String(answers || '');
    reply(id, {
      content: [{ type: 'text', text: text || '(no answer)' }],
      isError: false,
    });
  } catch (e) {
    reply(id, {
      content: [{ type: 'text', text: `ask_user failed: ${e.message}` }],
      isError: true,
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'mcc-ask', version: '0.1.0' },
    });
  } else if (method === 'notifications/initialized') {
    // notification, no response
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    handleToolCall(id, params);
  } else if (id != null) {
    fail(id, -32601, `method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
