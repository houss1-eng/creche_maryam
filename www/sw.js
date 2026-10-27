/* Service worker : l'application fonctionne hors-ligne une fois ouverte une première fois */
const CACHE = 'lamarelle-v8';
const FICHIERS = [
  './', './index.html', './style.css', './config.js', './app.js', './manifest.webmanifest', './img/logo.png',
  './marelle-cases.css', './img/marelle-texte.png', './fonts/nunito.woff2', './fonts/baloo2.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord (pour avoir la dernière version), cache si hors-ligne.
// Les réponses de l'API (/api/...) ne sont jamais mises en cache : données personnelles.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copie = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copie)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

// Notification envoyée par le serveur (Web Push) : affichée dans la barre du téléphone, même application fermée
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { texte: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titre || 'Abrar', {
    body: d.texte || 'Nouvelle notification',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: 'lamarelle-' + Date.now(),
    data: { type: d.type || '', texte: d.texte || '' }
  }));
});

// Toucher la notification : ouvre l'application (ou la ramène au premier plan) sur la page concernée (cantine, absences…)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(fenetres => {
    const f = fenetres.find(c => c.url.startsWith(self.registration.scope));
    const { type = '', texte = '' } = e.notification.data || {};
    if (f) { f.postMessage({ ouvrir: true, type, texte }); return f.focus(); }
    return self.clients.openWindow(`./index.html#notif=${encodeURIComponent(type)}&t=${encodeURIComponent(texte)}`);
  }));
});
