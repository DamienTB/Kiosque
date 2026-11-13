/* Service worker : l'app s'ouvre même hors connexion (avec la dernière édition connue),
   et les articles gardés dans « À lire » se lisent sans réseau (textes et images préchargés). */
const CACHE = 'kiosque-v2';
const ARTICLES = 'kiosque-articles';   // textes des articles gardés (rempli par app.js)
const IMAGES = 'kiosque-images';       // images de ces articles (rempli par app.js)
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'sources.json', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // on ne supprime que les anciennes versions de l'application, jamais les articles préchargés
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('kiosque-v') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const fromCache = (name, req) => caches.open(name).then((c) => c.match(req, { ignoreSearch: false, ignoreVary: true }));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.origin !== location.origin) {
    // images des journaux : celles des articles préchargés viennent du cache, les autres du réseau
    if (e.request.destination !== 'image') return;
    e.respondWith(fromCache(IMAGES, e.request.url).then((hit) => hit || fetch(e.request)));
    return;
  }

  if (url.pathname.includes('/data/articles/')) {
    // texte d'un article : le cache d'abord (il ne change pas), sinon le réseau
    e.respondWith(fromCache(ARTICLES, e.request.url).then((hit) => hit || fetch(e.request)));
    return;
  }

  // réseau d'abord (pour avoir la dernière version), cache en secours hors connexion
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
