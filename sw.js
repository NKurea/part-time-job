// バイト管理 Service Worker — アプリ本体をキャッシュしてオフラインでも開けるようにする
var CACHE = 'baito-v1';
var SHELL = [
	'./',
	'index.html',
	'style.css',
	'calc.js',
	'app.js',
	'manifest.webmanifest',
	'icons/icon.svg',
	'icons/icon-192.png',
	'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
	e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
	e.waitUntil(caches.keys().then(function (keys) {
		return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
	}).then(function () { return self.clients.claim(); }));
});

// 同一オリジンのみ：ネットワーク優先、オフライン時はキャッシュ
self.addEventListener('fetch', function (e) {
	var req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
	e.respondWith(fetch(req).then(function (res) {
		if (res.ok) {
			var copy = res.clone();
			caches.open(CACHE).then(function (c) { c.put(req, copy); });
		}
		return res;
	}).catch(function () {
		return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
	}));
});

self.addEventListener('notificationclick', function (e) {
	e.notification.close();
	e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
		for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
		return self.clients.openWindow('./');
	}));
});
