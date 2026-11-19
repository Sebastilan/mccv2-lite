// capture-proxy.mjs — per-actor 抓包层(cc-pool 进程内,原生 CC 路专用)。
//
//   与 memory-system 版的唯一差异:本版把上游 URL 改成【显式 upstream 入参】(见下),不再从
//   process.env.ANTHROPIC_BASE_URL 读——因为 per-provider override(GPT5 等会把 base_url 改成
//   ccr:3100)使 process.env 在 cc-pool 进程级是错的,真实上游只能由调用方按 actor 显式传入。
//
// 在 cc-pool 进程内起一个 127.0.0.1:0 的 http server,给该 actor 的原生 claude 设
// ANTHROPIC_BASE_URL 指向它,把 CC 发往真实上游(Anthropic 或既有 gateway)的请求原样透传、
// 响应流式回传(SSE 不缓冲),仅对 POST /v1/messages* 把请求体覆盖式落盘到
// STATE_DIR/last-request.json(+ turn-first / prev 轮换),供 ctx-inspector 逐字保真展示。
//
// ★ 转发为何走 curl 而非 node https/fetch:
//   实测 Anthropic 的 OAuth 端点(host provider, baseUrl=null, sk-ant-oat 令牌)对客户端 TLS
//   指纹(JA3)做 WAF 校验。内层 claude 是自带 node v24 的密封二进制、指纹放行;但本进程跑在
//   系统 node(如 v22),其 https/fetch 的 ClientHello 指纹被 Anthropic 判为 403 "Request not allowed"
//   (请求头/体逐字节相同也照拒,curl 同样的头体却 200)。故用 curl 子进程转发——指纹放行、与 node
//   版本无关。key 类 provider(deepseek 等 gateway)无此校验,curl 同样适用,单一代码路径。
//
// 故障安全(fail-open,红线):启动时无 curl / server 起失败 / 上游 URL 解析失败 → 返回 null
//   (调用方据此【裸跑】,让原生 claude 直连真实上游);转发出错 → 502 透传。任何情况下不能因
//   抓包让终端连不上上游。生命周期跟 actor 同生死(随 actor 起一次,跨 respawn 复用:闲置回收/换模型/崩溃后 --resume 重起)。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// curl 不该原样透传给上游的逐跳头(node http 解析后会规范化,转发时重设)
const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

// 主对话请求的工具数下界:CC harness 恒挂 31-33 个工具;子代理/sidecar 为 0。取 10 一刀切干净。
const MIN_MAIN_TOOLS = 10;

// 全局额度快照:任何成功响应头都带账号级 anthropic-ratelimit-unified-*(当前凭证的 5h/7d),覆盖式落到
// 固定路径,供 mccv2 /api/usage 读取。手动换 ~/.claude/.credentials.json 后下次任意请求即刷成新账号
// —— 换谁记谁、零额外 API 调用。纯旁路、异步、try/catch 包死,永不影响转发。
const USAGE_SNAPSHOT = path.join(process.env.HOME || '/tmp', '.cache/claude-usage/current.json');
let usageSnapDirReady = false;
function snapshotUsage(respHeaders, status) {
  try {
    if (status < 200 || status >= 300) return;
    const rl = {}; let org = null;
    for (const [k, v] of Object.entries(respHeaders)) {
      const lk = k.toLowerCase();
      if (lk.startsWith('anthropic-ratelimit-unified-')) rl[lk] = v;
      else if (lk === 'anthropic-organization-id') org = v;
    }
    if (rl['anthropic-ratelimit-unified-5h-utilization'] == null) return;  // 非账号级响应,跳过
    const write = () => {
      const tmp = `${USAGE_SNAPSHOT}.${process.pid}.tmp`;
      fs.writeFile(tmp, JSON.stringify({ ts: Date.now(), org_id: org, headers: rl }), err => {
        if (!err) fs.rename(tmp, USAGE_SNAPSHOT, () => {});   // 原子覆盖
      });
    };
    if (usageSnapDirReady) write();
    else fs.mkdir(path.dirname(USAGE_SNAPSHOT), { recursive: true }, () => { usageSnapDirReady = true; write(); });
  } catch { /* 快照永不影响转发 */ }
}

// 启动抓包代理。成功 → { baseURL, port, close() };失败 → null(调用方据此裸跑)。
//   stateDir: 落盘目录(per-actor 状态目录,= ~/.cache/memex/actors/<actorId>)
//   upstream: 真实上游 URL(该 actor 子进程本应使用的 ANTHROPIC_BASE_URL,即 providerEnv 合并后、
//             被本代理覆盖前那个值)。缺省 https://api.anthropic.com。★ 不再读 process.env。
//   log: 行日志函数
export function startCaptureProxy({ stateDir, upstream, log = () => {} }) {
  return new Promise((resolve) => {
    // 无 curl 不能转发 → 裸跑(不能让终端不可用)
    const probe = spawnSync('curl', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) { log('capture: 无 curl,裸跑'); return resolve(null); }

    const upstreamRaw = (upstream || 'https://api.anthropic.com').trim();
    let up;
    try { up = new URL(upstreamRaw); } catch (e) { log('capture: 上游 URL 解析失败,裸跑 ' + e.message); return resolve(null); }
    const upBase = up.origin + up.pathname.replace(/\/$/, '');   // gateway 可能带前缀
    const reqFile = path.join(stateDir, 'last-request.json');
    const metaFile = path.join(stateDir, 'last-request.meta.json');
    const prevFile = path.join(stateDir, 'prev-request.json');
    const prevMetaFile = path.join(stateDir, 'prev-request.meta.json');
    // 后锚:本轮第一次循环的输入体。isNewTurn 那一刻进来的 body 正好是本轮首轮,
    // 冻结于此;本轮后续工具续循环(非 isNewTurn)绝不覆盖 → 它恒停在本轮首轮那一份。
    const turnFirstFile = path.join(stateDir, 'turn-first.json');
    const turnFirstMetaFile = path.join(stateDir, 'turn-first.meta.json');
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* 目录已存在/不可建 → 落盘时 try 兜 */ }

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('error', e => log('capture: 请求读取出错 ' + e.message));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // ★ 矫正 CC WebSearch 侧请求与 adaptive-thinking 模型的不兼容:
        //   CC 的 WebSearch 工具会另发一个带服务端 web_search 工具的 /v1/messages 侧请求,
        //   且硬编码 thinking:{type:"disabled"}——fable 系 adaptive 模型对此直接 400。
        //   转发前删掉该字段(API 默认即 adaptive),对其他请求零影响;CC 上游修复后此分支自然失效。
        let isSideReq = false;   // web_search 侧请求:仅用于 thinking:disabled 矫正
        let isMainReq = false;   // 主对话请求:带完整 harness(非空 system + 工具齐全),才准进轮换/冻结
        let isNewTurn = false;   // 末消息是真 user 文本(非 tool_result 续轮)= 新一轮对话开始
        if (req.method === 'POST' && /^\/v1\/messages/.test(req.url)) {
          try {
            const b = JSON.parse(body.toString('utf8'));
            if ((b.tools || []).some(t => /^web_search/.test(t?.type || '')) || /haiku/.test(b.model || '')) isSideReq = true;
            if (b?.thinking?.type === 'disabled' && isSideReq) {
              delete b.thinking;
              body = Buffer.from(JSON.stringify(b), 'utf8');
              log('capture: web_search 侧请求剔除 thinking:disabled');
            }
            // ★ 正向门:只有完整 harness 的主对话请求才算 isMainReq,才能进 last/prev/turn-first 轮换。
            //   黑名单(web_search/haiku)挡不住「opus 子代理/结构化一次性调用」——它们 model=opus、
            //   isNewTurn=true,会覆盖 turn-first / 污染 prev → diff 锚点失真(2026-06-23 实测踩坑)。
            //   主对话恒 system 非空 + 工具 31-33 个;子代理/sidecar 是 system 空或 tools=0 → 一刀切干净。
            const sys = b.system;
            const sysNonEmpty = typeof sys === 'string' ? sys.length > 0 : (Array.isArray(sys) && sys.length > 0);
            isMainReq = !isSideReq && sysNonEmpty && (b.tools || []).length >= MIN_MAIN_TOOLS;
            const lastMsg = (b.messages || [])[(b.messages || []).length - 1];
            if (lastMsg?.role === 'user') {
              const c = lastMsg.content;
              isNewTurn = typeof c === 'string' || (Array.isArray(c) && !c.some(p => p?.type === 'tool_result'));
            }
          } catch { /* 非 JSON 体,原样透传 */ }
        }

        // 仅 POST /v1/messages* 主对话请求落盘(覆盖式)。轮换按「对话轮」而非「API 请求」:
        // 一轮内 CC 每调一次工具就发一次请求,若每请求都轮换,prev 会是同轮倒数第二次请求,
        // diff 出来只剩最后一个工具结果是新的——检视器整页全绿,失去意义(2026-06-13 实地踩坑)。
        // 故仅在新一轮开始(末消息为真 user 文本)时 last→prev:prev 恒为上一轮末态,
        // last 为本轮当前态,前缀 diff 即「本轮新增了什么」。
        // 仅完整 harness 的主对话请求(isMainReq)进轮换:侧请求/opus 子代理混进来会把
        // prev/turn-first 换成无关体,diff 锚点失真(2026-06-12 / 2026-06-23 实地踩坑)。
        if (req.method === 'POST' && /^\/v1\/messages/.test(req.url) && isMainReq) {
          if (isNewTurn) {
            try { fs.renameSync(reqFile, prevFile); fs.renameSync(metaFile, prevMetaFile); } catch { /* 首轮无 last,忽略 */ }
            // 冻结本轮首轮(后锚):仅在新一轮开始时写,本轮后续工具循环不再触碰。
            fs.writeFile(turnFirstFile, body, err => {
              if (err) { log('capture: 写 turn-first.json 失败 ' + err.message); return; }
              fs.writeFile(turnFirstMetaFile, JSON.stringify({ ts: Date.now(), url: req.url, bodyBytes: body.length }), () => {});
            });
          }
          fs.writeFile(reqFile, body, err => {
            if (err) { log('capture: 写 last-request.json 失败 ' + err.message); return; }
            fs.writeFile(metaFile, JSON.stringify({ ts: Date.now(), url: req.url, bodyBytes: body.length }), () => {});
          });
        }

        // —— curl 转发:-i 带响应头、-N/--no-buffer 流式(SSE 不缓冲)、@- 从 stdin 读体 ——
        const curlArgs = ['-sS', '-N', '--no-buffer', '-i', '--suppress-connect-headers', '-X', req.method, upBase + req.url, '--data-binary', '@-', '-H', 'Expect:'];
        for (const [k, v] of Object.entries(req.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          curlArgs.push('-H', `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        const curl = spawn('curl', curlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        curl.stderr.on('data', d => { stderr += d; });
        curl.on('error', e => { log('capture: curl spawn 失败 ' + e.message); try { res.writeHead(502); res.end('capture-proxy curl error: ' + e.message); } catch {} });

        // curl stdout = 原始 HTTP 响应(状态行 + 头 + 空行 + 体)。攒到 header 边界后 writeHead,余下流式 pipe。
        // 经 CONNECT 代理(https_proxy)时 curl 会先打印「HTTP/1.1 200 Connection established」预导块——
        // --suppress-connect-headers 已抑制,这里再防御性跳过任何 CONNECT/1xx 预导块,定位到真正响应头。
        let headerBuf = Buffer.alloc(0), headersSent = false;
        curl.stdout.on('data', chunk => {
          if (headersSent) { res.write(chunk); return; }
          headerBuf = Buffer.concat([headerBuf, chunk]);
          // 剥掉所有 CONNECT/1xx 预导块
          for (;;) {
            const s = headerBuf.indexOf('\r\n\r\n');
            if (s < 0) return;                                 // 头未收全,继续攒
            const fl = headerBuf.slice(0, headerBuf.indexOf('\r\n')).toString('utf8');
            const c = parseInt((fl.match(/HTTP\/[\d.]+\s+(\d+)/) || [])[1] || '0', 10);
            if ((c >= 100 && c < 200) || /Connection established/i.test(fl)) { headerBuf = headerBuf.slice(s + 4); continue; }
            break;
          }
          const sep = headerBuf.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const rest = headerBuf.slice(sep + 4);
          const lines = headerBuf.slice(0, sep).toString('utf8').split('\r\n');
          const status = parseInt((lines[0].match(/HTTP\/[\d.]+\s+(\d+)/) || [])[1] || '502', 10);
          const respHeaders = {};
          for (const l of lines.slice(1)) {
            const i = l.indexOf(':'); if (i <= 0) continue;
            const name = l.slice(0, i).trim(), val = l.slice(i + 1).trim();
            if (HOP_BY_HOP.has(name.toLowerCase())) continue;  // 帧由 node 管,别透传 transfer-encoding/connection
            respHeaders[name] = val;
          }
          try { res.writeHead(status, respHeaders); } catch (e) { log('capture: writeHead 失败 ' + e.message); }
          snapshotUsage(respHeaders, status);   // 顺手记一笔当前凭证的真实额度(旁路,不影响转发)
          if (rest.length) res.write(rest);
          headersSent = true;
        });
        curl.stdout.on('end', () => { try { res.end(); } catch {} });
        curl.on('close', code => {
          if (code !== 0 && !headersSent) {
            log(`capture: curl 退出 ${code} ${stderr.trim().slice(0, 200)}`);
            try { res.writeHead(502); res.end('capture-proxy upstream error'); } catch {}
          }
        });
        curl.stdin.on('error', () => {});                      // 上游早断时忽略 EPIPE
        curl.stdin.end(body);
      });
    });

    server.on('error', e => { log('capture: server 启动失败,裸跑 ' + e.message); resolve(null); });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log(`capture: 代理就绪 http://127.0.0.1:${port} → ${upBase}`);
      resolve({ baseURL: `http://127.0.0.1:${port}`, port, close: () => { try { server.close(); } catch {} } });
    });
  });
}
