'use strict';

/* SightSize service worker — offline app-shell + cache-busting per deploy.
   __BUILD__ wordt bij het deployen vervangen door de commit-SHA, zodat elke
   nieuwe versie een verse cache krijgt en de oude wordt opgeruimd. */

const VERSION = '__BUILD__';
const CACHE = 'sightsize-' + VERSION;

// de app-shell; de css/js dragen dezelfde ?v=-stempel als in index.html
const ASSETS = [
  './',
  './index.html',
  './css/style.css?v=__BUILD__',
  './js/core.js?v=__BUILD__',
  './js/viewer.js?v=__BUILD__',
  './js/app.js?v=__BUILD__',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {}) // een ontbrekend asset mag de installatie niet blokkeren
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // alleen eigen bestanden

  // navigatie (de HTML): netwerk eerst voor verse versie, val offline terug op cache
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // overige bestanden: cache eerst, anders netwerk (en bewaar voor de volgende keer)
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
