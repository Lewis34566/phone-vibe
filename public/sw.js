/* Service Worker：缓存应用外壳，实现"添加到主屏幕"离线可用 */
const CACHE = 'phone-vibe-v3';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API / 项目预览永远走网络
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/')) return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((resp) => {
        if (resp.ok && url.origin === location.origin) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match('/index.html'))
    )
  );
});
