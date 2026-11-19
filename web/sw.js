// sw.js — Service Worker：分层缓存策略
//   /dist/* （hash 文件名，永不变内容）→ cache-first，命中即用
//   其它（index.html、style.css、html 页面等）→ stale-while-revalidate，先吐缓存后台更新
//   /api/* → 不走 SW
const CACHE = 'mcc-lite-v1';  // 改前端缓存策略时 bump
const SHARE_CACHE = 'mcc-share';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => self.clients.matchAll().then(cls =>
      cls.forEach(c => c.postMessage({ type: 'sw-updated' }))
    ))
  );
});

// Web Share Target: 拦截 POST /api/share-target，把图片存入 Cache 后重定向到选择页
async function handleShareTarget(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('image');
    if (!file || !file.size) return Response.redirect('/share-target.html?error=no_image', 303);
    const id = crypto.randomUUID();
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(`/share/${id}`, new Response(file, {
      headers: { 'Content-Type': file.type || 'image/png', 'X-Share-Name': file.name || 'share.png' },
    }));
    return Response.redirect(`/share-target.html?id=${id}`, 303);
  } catch (e) {
    return Response.redirect('/share-target.html?error=sw_error', 303);
  }
}

// hash 文件名（如 dist/app.HLQXICQJ.js）—— 内容永远对应同名文件，命中即用，永不重拉
function isImmutable(path) {
  return /\/dist\/[^/]+\.[A-Z0-9]{6,}\.[a-z]+$/i.test(path);
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fetching = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  // 先返缓存；没缓存就等网络
  return hit || (await fetching) || new Response('offline', { status: 503 });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const path = url.pathname;

  // 拦截 Web Share Target POST
  if (e.request.method === 'POST' && (path === '/api/share-target' || path.endsWith('/api/share-target'))) {
    e.respondWith(handleShareTarget(e.request));
    return;
  }

  if (e.request.method !== 'GET') return;
  if (path.includes('/api/')) return;
  if (path.endsWith('/sw.js')) return;
  if (path.endsWith('/auth/login')) return;

  if (isImmutable(path)) {
    e.respondWith(cacheFirst(e.request));
  } else {
    e.respondWith(staleWhileRevalidate(e.request));
  }
});
