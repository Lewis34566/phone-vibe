/* Service Worker：网络优先（保证更新即时生效），断网时回退缓存 */
const CACHE = 'phone-vibe-v11';

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
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
  if (e.request.method !== 'GET') return;
  // 网络优先：在线时永远拿最新；失败（断网）才回退缓存
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok && url.origin === location.origin) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
