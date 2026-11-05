/* FOMO Desk service worker (STEP 8).
   - Caches the app shell so the home-screen app opens offline (last good numbers come from
     the app's own localStorage; the error row says "Desk offline").
   - Never caches desk data: ./d/** (Plan B JSON) and ./api/** always go to the network.
   - Web push (Plan A only): shows "Grok Bot · now" with the payload's FOMO link;
     tapping opens that link (links.coin_url built on the desk). Plan B = Telegram only. */
var SHELL = 'fomo-shell-v2';
var ASSETS = ['./', './index.html', './app.css', './app.js', './chart.js', './manifest.json', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isData(url) { return /\/(d|api)\//.test(url.pathname); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || isData(url)) return;   // data: straight to network
  // shell: network first (fresh deploys win), cache as fallback
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('./index.html'); });
  }));
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var url = /^https:\/\//.test(d.url || '') ? d.url : null;
  e.waitUntil(self.registration.showNotification(d.title || 'Grok Bot \u00b7 now', {
    body: d.body || '',
    icon: d.icon || './icons/apple-touch-icon.png',
    badge: './icons/apple-touch-icon.png',
    data: { url: url },
    tag: d.tag || undefined
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = e.notification.data && e.notification.data.url;
  e.waitUntil(url ? self.clients.openWindow(url) : self.clients.matchAll({ type: 'window' }).then(function (cs) {
    if (cs.length) return cs[0].focus();
    return self.clients.openWindow('./');
  }));
});
