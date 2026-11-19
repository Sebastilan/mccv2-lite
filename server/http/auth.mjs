// auth.mjs — Cookie 登录认证（v2，从 v1 移植并按 v2 路由调整白名单）
//
// - 密码：MCC_PASSWORD_HASH（sha256 hex）或 MCC_PASSWORD（明文，启动时 hash）；都没设则只放行本机请求
// - Cookie：mcc_auth，HMAC-SHA256 签名，30 天有效
// - localhost 请求直接放行（advisor 本地调试）

import { createHmac, createHash, randomBytes } from 'crypto';
import { getScopedActorFromCookie } from '../review/actor-share.mjs';

const RAW_PASSWORD  = process.env.MCC_PASSWORD || '';
const AUTH_SECRET   = process.env.MCC_AUTH_SECRET || randomBytes(32).toString('hex');
const COOKIE_NAME   = 'mcc_auth';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600; // 30 days

// 优先用 MCC_PASSWORD_HASH（与 v1 兼容），fallback 到 MCC_PASSWORD 启动时 hash
const PASSWORD_HASH = process.env.MCC_PASSWORD_HASH
  || (RAW_PASSWORD ? createHash('sha256').update(RAW_PASSWORD).digest('hex') : '');

// ─── localhost 检测 ───

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// 经反向代理(Caddy/Nginx 等,同机转发到 127.0.0.1)进来的请求带转发头:一律当外部请求,必须登录。
// 本机子进程回调(ask_user、mcc-msg)直连、不带这些头,不受影响。
const FORWARD_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

function isLocalhost(req) {
  if (FORWARD_HEADERS.some(h => req.headers?.[h])) return false;
  return LOCALHOST_ADDRS.has(req.socket?.remoteAddress);
}

// ─── Cookie 工具 ───

// 老 Android 9 WebView 对 >~70 字符的 cookie 值会截断（实测 HMAC-SHA256 64 hex
// chars 补上 timestamp 和 mcc_auth= 后超 80，document.cookie 读到的是截断值）。
// 对策：签名只取前 32 hex chars（128-bit 安全强度），总长度 ~46 chars。
// verifyCookie 取前 32 chars 比对，向后兼容旧 64-char cookie。
function makeCookie() {
  const expiry = Date.now() + COOKIE_MAX_AGE_S * 1000;
  const sig = createHmac('sha256', AUTH_SECRET).update(String(expiry)).digest('hex').substring(0, 32);
  return `${expiry}.${sig}`;
}

function verifyCookie(value) {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const expiryStr = value.slice(0, dot);
  const sig       = value.slice(dot + 1).substring(0, 32);
  const expiry    = parseInt(expiryStr);
  if (isNaN(expiry) || Date.now() > expiry) return false;
  const expected = createHmac('sha256', AUTH_SECRET).update(expiryStr).digest('hex').substring(0, 32);
  return sig === expected;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const map = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

// ─── 认证检查（主入口） ───

/**
 * 检查请求是否已认证。
 * - 已认证 / localhost → 返回 true；未设密码时非本机一律 403（全权限，req.scopedActor 保持未设）
 * - 仅持有效 mcc_share（分享链接凭证）→ 返回 true 但置 req.scopedActor=<actorId>（作用域访客，
 *   由 actor-share.guardScopedRequest 收窄到该 actor；安全边界在后端强制）
 * - 未认证 → 向 res 写 401 或登录页，返回 false
 */
export function checkAuth(req, res) {
  if (isLocalhost(req)) return true;
  if (!PASSWORD_HASH) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('MCC_PASSWORD 未设置：只允许本机访问。设置后重启即可从手机/其他设备登录。\n');
    return false;
  }

  const cookies = parseCookies(req);
  if (verifyCookie(cookies[COOKIE_NAME])) return true;   // 全站凭证 → 全权限，不作用域

  // 无全站凭证但持有效分享凭证 → 放行为「作用域访客」（标记 scopedActor，供门控收窄）
  const scoped = getScopedActorFromCookie(req);
  if (scoped) { req.scopedActor = scoped; return true; }

  const url  = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // API → JSON 401
  if (path.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  // WebSocket upgrade → 401
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    res.writeHead(401);
    res.end('Unauthorized');
    return false;
  }

  // 其他 HTML 请求 → 登录页
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOGIN_PAGE_HTML);
  return false;
}

// ─── 登录处理 ───

/**
 * POST /auth/login  { password }
 * 返回 JSON { ok } + Set-Cookie，前端 JS 做跳转
 */
export function handleLogin(req, res, body, contentType) {
  const isFormPost = contentType && contentType.includes('x-www-form-urlencoded');

  if (!PASSWORD_HASH) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: 'MCC_PASSWORD 未设置' }));
  }

  let password = '';
  try { password = JSON.parse(body).password || ''; } catch {
    const params = new URLSearchParams(body);
    password = params.get('password') || '';
  }

  const hash = createHash('sha256').update(password).digest('hex');
  if (hash !== PASSWORD_HASH) {
    if (isFormPost) {
      // 密码错误 → 回到登录页，带错误提示（简单 query 参数）
      res.writeHead(302, { 'Location': '/?error=1' });
      return res.end();
    }
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '密码错误' }));
  }

  const cookie = `${COOKIE_NAME}=${makeCookie()}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
  if (isFormPost) {
    // 传统 form POST → 302 跳转，不带 JS 的浏览器也能登录
    res.writeHead(302, { 'Location': '/', 'Set-Cookie': cookie });
    return res.end();
  }
  // JSON API → 返回 { ok: true }，前端 JS 做跳转
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookie,
  });
  res.end(JSON.stringify({ ok: true }));
}

// ─── WebSocket 认证 ───

// 返回 { ok, scopedActor }：
//   全权限（localhost / 无密码 / 有效 mcc_auth）→ { ok:true, scopedActor:null }
//   作用域访客（仅有效 mcc_share）           → { ok:true, scopedActor:<actorId> }
//   未认证                                    → { ok:false, scopedActor:null }
export function checkWsAuth(req) {
  if (isLocalhost(req)) return { ok: true, scopedActor: null };
  if (!PASSWORD_HASH) return { ok: false, scopedActor: null };
  const cookies = parseCookies(req);
  if (verifyCookie(cookies[COOKIE_NAME])) return { ok: true, scopedActor: null };
  const scoped = getScopedActorFromCookie(req);
  if (scoped) return { ok: true, scopedActor: scoped };
  return { ok: false, scopedActor: null };
}

// ─── 登录页 HTML ───
// 双模提交：现代浏览器走 fetch（JSON 响应），老旧 WebView 走 <form> POST（302 跳转）

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCC Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{background:#fff;border-radius:12px;padding:40px 32px;width:320px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
.card h1{font-size:1.25rem;font-weight:600;color:#333;margin-bottom:24px}
.card input{width:100%;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:1rem;outline:none;transition:border .2s}
.card input:focus{border-color:#666}
.card button{width:100%;margin-top:16px;padding:10px;border:none;border-radius:8px;background:#333;color:#fff;font-size:1rem;cursor:pointer;transition:background .2s}
.card button:hover{background:#555}
.card button:disabled{opacity:.6;cursor:default}
.error{color:#d32f2f;font-size:.875rem;margin-bottom:12px;display:none}
</style>
</head>
<body>
<div class="card">
<h1>MCC</h1>
<div class="error" id="err"></div>
<form method="POST" action="/auth/login" id="login-form">
<input type="password" name="password" id="pw" placeholder="密码" autofocus autocomplete="current-password">
<button type="submit" id="btn">登录</button>
</form>
</div>
<script>
(function(){
  var form=document.getElementById("login-form");
  if(!form||!window.fetch)return;  // 无 fetch → 走原生 form POST
  form.addEventListener("submit",function(e){
    e.preventDefault();
    var pw=document.getElementById("pw").value;
    if(!pw)return;
    var btn=document.getElementById("btn");
    btn.disabled=true;btn.textContent="...";
    fetch("/auth/login",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){location.href="/";}
      else{var er=document.getElementById("err");er.textContent=d.error||"失败";er.style.display="block";btn.disabled=false;btn.textContent="登录";}
    }).catch(function(){btn.disabled=false;btn.textContent="登录";});
  });
})();
</script>
</body>
</html>`;
