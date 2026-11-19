// server.mjs — HTTP/WS 服务（静态文件 + /api/* 路由 + WS 注册）
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { HumanAdapter } from '../terminals/human/human.mjs';
import { handleActorsApi } from '../api/actors.mjs';
import { handleActorBusApi } from '../api/actor-bus.mjs';
import { handleObsApi } from '../api/observability.mjs';
import { handleBizApi } from '../api/index.mjs';
import { handleHistoryApi } from '../api/history.mjs';
import { handleEventsApi } from '../api/events.mjs';
import { handleCompatApi } from '../api/compat.mjs';
import { obs } from '../ops/observability.mjs';
import { checkAuth, handleLogin, checkWsAuth } from './auth.mjs';
import { handleShareEntry, handleShareApi, guardScopedRequest } from '../review/actor-share.mjs';
import { templateHtml, pickEncoding, watchManifest, getManifest } from './frontend-bundle.mjs';
import { installCompression } from './http-compress.mjs';
import { listenHosts } from '../ops/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map':  'application/json',
};

// 注册 manifest 热加载（build 后无需重启主线）
watchManifest();

// 模板化 index.html：根据 manifest.assets 替换 src=/href= 资源引用
function serveIndex(res) {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(filePath)) return false;
  const html = templateHtml(fs.readFileSync(filePath, 'utf8'));
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Cache-Control': 'no-cache',  // hash 在引用里，html 本身不长缓存
  });
  res.end(html);
  return true;
}

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://localhost').pathname;
  if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);
  const filePath = path.join(PUBLIC_DIR, urlPath.replace(/\.\./g, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return true; }
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return false;
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': mime };
  // review.html 改动频繁（PDF 渲染/批注算法迭代中），禁止浏览器缓存避免用户拿到旧版
  if (urlPath === '/review.html') {
    headers['Cache-Control'] = 'no-cache, must-revalidate';
  }
  // dist/* 文件名带 hash，immutable + 协商压缩
  let serveFilePath = filePath;
  if (urlPath.startsWith('/dist/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    const picked = pickEncoding(filePath, req.headers['accept-encoding'] || '');
    if (picked.encoding) {
      serveFilePath = picked.filePath;
      headers['Content-Encoding'] = picked.encoding;
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = fs.statSync(serveFilePath).size;
    }
  }
  res.writeHead(200, headers);
  fs.createReadStream(serveFilePath).pipe(res);
  return true;
}

export function createServer({ port, bus, broadcaster, poolSupervisor }) {
  const adapters = new Map(); // actorId -> HumanAdapter

  const httpServer = http.createServer((req, res) => {
    installCompression(req, res);   // 动态 JSON/text 响应透明 gzip（流式 pipe 自动让路）
    const urlPath = new URL(req.url, 'http://localhost').pathname;

    // ── 鉴权白名单（无需 cookie） ──
    // 0.5 分享访客入口 /s/:token（token 自鉴，种 mcc_share cookie → 302 跳单对话页，像 review 一样白名单）
    if (req.method === 'GET' && urlPath.startsWith('/s/')) {
      handleShareEntry(req, res);
      return;
    }
    // 1. 登录接口
    if (req.method === 'POST' && urlPath === '/auth/login') {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      const ct = req.headers['content-type'] || '';
      req.on('end', () => handleLogin(req, res, Buffer.concat(chunks).toString('utf-8'), ct));
      return;
    }
    // 2. 静态 JS / CSS（浏览器无 cookie 时也要能加载）
    const isStaticAsset = req.method === 'GET' && /\.(js|css|png|svg|ico|woff2|map|webmanifest)$/.test(urlPath);
    // 3. 健康检查（公开）
    const isHealth = urlPath === '/api/plugins/health';
    // 4. review token 自鉴
    // 注册新分享（/api/review/share）必须登录；持 token 的读与批注才免登录
    const isReview = (urlPath.startsWith('/api/review/') && urlPath !== '/api/review/share') || urlPath === '/review.html';
    const bypass = isStaticAsset || isHealth || isReview;
    if (!bypass && !checkAuth(req, res)) return;

    // 作用域访客（持 mcc_share）：进入数据面前先过门控——默认拒绝 + 白名单放行，
    // 后端强制它只碰授权 actor（即便手搓 URL/API）。全权限会话 req.scopedActor 未设，跳过。
    if (req.scopedActor && !guardScopedRequest(req, res)) return;

    if (handleObsApi(req, res, { bus, broadcaster, poolSupervisor }) !== false) return;
    if (handleShareApi(req, res, bus) !== false) return;
    if (handleActorsApi(req, res, bus, poolSupervisor, broadcaster) !== false) return;
    if (handleActorBusApi(req, res, bus) !== false) return;
    if (handleBizApi(req, res, { bus }) !== false) return;
    if (handleHistoryApi(req, res, bus, poolSupervisor, broadcaster) !== false) return;
    if (handleEventsApi(req, res, bus) !== false) return;
    if (handleCompatApi(req, res, { poolSupervisor }) !== false) return;
    if (req.method === 'GET' && serveStatic(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  // WS 存活心跳：协议级 ping/pong + 清理「半死」连接。
  // 移动端锁屏/切后台后 socket 常变半死（readyState=OPEN 但底层已断），不清理会让
  // broadcaster 持续往死 socket 写、wsMap 残留，且该 ws 永不 close。每轮 ping 一次，
  // 下一轮仍未收到 pong（浏览器自动回）则 terminate → 触发 close → removeWS。
  const WS_HEARTBEAT_MS = 30000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, WS_HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const wsAuth = checkWsAuth(req);
    if (!wsAuth.ok) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    // 作用域访客的 ws 打标：broadcaster 据此按 actor 过滤投递（只收授权 actor 的消息/更新，
    // 不收全站火筒）；null=全权限，行为零变化。
    ws._scopedActor = wsAuth.scopedActor || null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'register') {
        ws.close(1008, 'first message must be register');
        return;
      }
      let { actorId } = msg;
      // 作用域访客：只允许以「自己那个 actor」或 human_self 身份注册；越权注册别的 actor → 立即关闭。
      // 一律落到 human_self 频道（共享人类 adapter，不新建/不改写任何 actor 行），投递由
      // ws._scopedActor 在 broadcaster 层过滤（见 broadcast.mjs），杜绝跨 actor 泄漏。
      if (ws._scopedActor) {
        if (actorId !== ws._scopedActor && actorId !== 'human_self') {
          ws.close(4003, 'forbidden: outside share scope');
          return;
        }
        actorId = 'human_self';
      }
      let adapter = adapters.get(actorId);
      if (!adapter) {
        adapter = new HumanAdapter(actorId, {}, bus);
        adapter.start();
        adapters.set(actorId, adapter);
        obs.counter('ws.registered');
        obs.recordTrace({ type: 'human_registered', actorId });
      }
      adapter.bindWebSocket(ws);
      broadcaster.addWS(actorId, ws);
      ws.send(JSON.stringify({ type: 'registered', actorId }));
    });

    ws.on('close', () => {
      broadcaster.removeWS(ws);
    });

    ws.on('error', (err) => {
      console.error('[server] ws error:', err.message);
    });
  });

  // MCC_HOST:监听地址,解析见 ops/config.mjs。不设=只听 127.0.0.1;lan=局域网网卡 + 127.0.0.1。
  // 第二个地址用 net 监听后把连接交给同一个 httpServer(WebSocket 升级照常),本机免密判定不变。
  const [host, ...extra] = listenHosts();
  if (process.env.MCC_HOST === 'lan' && host === '127.0.0.1') console.warn('[server] MCC_HOST=lan 但没找到局域网网卡的私网 IPv4,只听 127.0.0.1');
  httpServer.listen(port, host, () => {
    console.log(`[server] HTTP/WS listening on ${[host, ...extra].map(h => `${h}:${port}`).join(' + ')}`);
  });
  for (const h of extra) {
    const side = net.createServer(sock => httpServer.emit('connection', sock));
    side.on('error', err => console.error(`[server] listen ${h}:${port} failed:`, err.message));
    side.listen(port, h);
    httpServer.on('close', () => side.close());
  }

  return httpServer;
}
