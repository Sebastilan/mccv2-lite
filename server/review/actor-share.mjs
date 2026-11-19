// actor-share.mjs — 终端「可分享链接」：窄锁凭证 + 访客入口 + 作用域门控（单一收口点）
//
// 一文一职：把某个 CC 终端做成一条「谁拿到链接谁能看/能聊、但只能看这一个」的分享。
//   1. token 模型（biz.db share_links）：createLink / resolve / revoke / revokeByActor / listByActor
//   2. 访客入口 GET /s/:token —— 自鉴（像 review 那样），种作用域 cookie mcc_share → 302 跳单对话页
//   3. 作用域门控 guardScopedRequest —— 持 mcc_share 的请求「默认拒绝 + 白名单放行」，
//      后端强制:即使手搓 URL/API 也碰不到别的 actor（安全边界在后端，不在前端）
//   4. share 管理 API（本人鉴权）：POST/DELETE/GET /api/actors/:id/share + GET /api/scope
//
// 安全命门：作用域判断收敛在这里 + auth.mjs（cookie→scopedActor），各 api 模块不各自解析 cookie。
import crypto from 'crypto';
import { bizDb } from '../bus/biz-db.mjs';

const SHARE_COOKIE = 'mcc_share';
// cookie 长期有效（分享链接是长期凭证；吊销靠 revoke，不靠过期）
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function genToken() {
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes).map(b => BASE62[b % 62]).join('');
}

// ─── token 模型 ───

/** 为 actor 生成一条新分享链接，返回 { token, actorId, createdAt }。 */
export function createLink(actorId) {
  const token = genToken();
  const now = Date.now();
  bizDb.prepare(
    'INSERT INTO share_links (token, actor_id, created_at, revoked) VALUES (?, ?, ?, 0)'
  ).run(token, actorId, now);
  return { token, actorId, createdAt: now };
}

/** token → actorId（仅未吊销）；无效/已吊销 → null。 */
export function resolve(token) {
  if (!token || typeof token !== 'string') return null;
  const row = bizDb.prepare(
    'SELECT actor_id FROM share_links WHERE token = ? AND revoked = 0'
  ).get(token);
  return row ? row.actor_id : null;
}

/** 吊销单个 token。返回是否命中。 */
export function revoke(token) {
  const info = bizDb.prepare('UPDATE share_links SET revoked = 1 WHERE token = ? AND revoked = 0').run(token);
  return info.changes > 0;
}

/** 吊销某 actor 的全部链接（「停用分享」）。返回吊销条数。 */
export function revokeByActor(actorId) {
  const info = bizDb.prepare('UPDATE share_links SET revoked = 1 WHERE actor_id = ? AND revoked = 0').run(actorId);
  return info.changes;
}

/** 列某 actor 的未吊销链接（用于 UI 判断「已分享/未分享」）。 */
export function listByActor(actorId) {
  return bizDb.prepare(
    'SELECT token, actor_id AS actorId, created_at AS createdAt FROM share_links WHERE actor_id = ? AND revoked = 0 ORDER BY created_at DESC'
  ).all(actorId);
}

// ─── cookie 工具 ───

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const map = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k) map[k] = pair.slice(eq + 1).trim();
  }
  return map;
}

/** 从请求 cookie 解析作用域 actorId（供 auth.mjs 复用，收口 mcc_share → actor）。 */
export function getScopedActorFromCookie(req) {
  const token = parseCookies(req)[SHARE_COOKIE];
  return resolve(token);
}

// ─── 访客入口 GET /s/:token ───

function invalidPage(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>链接失效</title>
<style>body{min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#555}
.card{background:#fff;border-radius:12px;padding:36px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
h1{font-size:1.1rem;margin:0 0 8px;color:#333}p{margin:0;font-size:.9rem;color:#888}</style></head>
<body><div class="card"><h1>分享链接已失效</h1><p>该链接不存在或已被停用。</p></div></body></html>`);
}

/**
 * GET /s/:token —— 访客入口（server.mjs 白名单 bypass，token 自鉴）。
 * 有效 → 种 mcc_share cookie（HttpOnly）→ 302 跳 /#/chat?id=<actorId>。无效 → 提示页。
 */
export function handleShareEntry(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.pathname.slice('/s/'.length);
  const actorId = resolve(token);
  if (!actorId) { invalidPage(res); return; }
  const cookie = `${SHARE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
  res.writeHead(302, {
    'Set-Cookie': cookie,
    'Location': `/#/chat?id=${encodeURIComponent(actorId)}`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

// ─── 作用域门控（HTTP，默认拒绝 + 白名单放行）───
//
// 仅当 req.scopedActor 已被 auth.checkAuth 置位时调用。返回 true=放行(继续分发)，
// false=已写 403(调用方直接 return)。非 /api/ 路径(SPA html/资源)一律放行。
export function guardScopedRequest(req, res) {
  const S = req.scopedActor;
  const url = new URL(req.url, 'http://localhost');
  const P = url.pathname;
  const M = req.method;

  if (!P.startsWith('/api/')) return true;   // SPA 页面/静态资源，非数据面

  const allow =
    (M === 'GET'  && P === '/api/scope') ||
    (M === 'GET'  && P === '/api/actors') ||                    // api-actors 会裁剪成仅这一个
    (M === 'GET'  && P === `/api/actors/${S}`) ||
    (M === 'GET'  && P === `/api/actors/${S}/messages`) ||
    (M === 'GET'  && P === `/api/actors/${S}/context`) ||
    (M === 'POST' && P === '/api/messages');                    // api-actors 校验 to_id===S

  if (allow) return true;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'forbidden: outside share scope' }));
  return false;
}

// ─── share 管理 API（薄壳，挂在 server.mjs 分发链）───
//   POST   /api/actors/:id/share   本人生成链接 → { token, url }
//   DELETE /api/actors/:id/share   本人停用该 actor 全部链接
//   GET    /api/actors/:id/share   列当前有效链接（判断已/未分享）
//   GET    /api/scope              当前会话作用域（{ scoped, actorId }）——前端识别访客模式
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function handleShareApi(req, res, bus) {
  const url = new URL(req.url, 'http://localhost');
  const P = url.pathname;
  const M = req.method;

  // GET /api/scope —— 全权限会话返回 scoped:false；作用域访客返回 scoped:true + actorId
  if (M === 'GET' && P === '/api/scope') {
    json(res, 200, { scoped: !!req.scopedActor, actorId: req.scopedActor || null });
    return true;
  }

  const m = P.match(/^\/api\/actors\/([^/]+)\/share$/);
  if (!m) return false;
  const actorId = m[1];

  // 生成链接（本人）：actor 必须存在且未消失
  if (M === 'POST') {
    const row = bus.db.prepare("SELECT id FROM actors WHERE id=? AND status!='gone'").get(actorId);
    if (!row) { json(res, 404, { error: 'actor not found or gone' }); return true; }
    const { token } = createLink(actorId);
    json(res, 201, { token, actorId, path: `/s/${token}` });
    return true;
  }

  // 停用该 actor 全部链接（本人）
  if (M === 'DELETE') {
    const n = revokeByActor(actorId);
    json(res, 200, { ok: true, revoked: n });
    return true;
  }

  // 列当前有效链接（本人）
  if (M === 'GET') {
    const links = listByActor(actorId);
    json(res, 200, { actorId, links });
    return true;
  }

  return false;
}
