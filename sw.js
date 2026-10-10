'use strict';

const CACHE_NAME = 'fumizukue-series-chapter-v7';
const SCOPE = self.registration.scope;
const SCOPE_URL = new URL(SCOPE);
const shellUrl = path => new URL(path, SCOPE).href;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './chapter-workspace.css',
  './series.css',
  './model.js',
  './core.js',
  './editor-state.js',
  './migration.js',
  './package.js',
  './workspace-mode.js',
  './storage.js',
  './series-storage.js',
  './series-schema.js',
  './workspace-storage.js',
  './images.js',
  './archive-common.js',
  './archive.js',
  './series-archive.js',
  './chapter-bundle.js',
  './chapter-archive.js',
  './vendor/fflate.mjs',
  './plot.js',
  './plot-overview.js',
  './characters.js',
  './app.js',
  './series.js',
  './chapter-workspace-controller.js',
  './workspace-loader.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
].map(shellUrl);
const APP_SHELL_URLS = new Set(APP_SHELL);

const OFFLINE_DOCUMENT = shellUrl('./index.html');

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('fumizukue-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;
  if (request.mode === 'navigate') { event.respondWith(cacheFirst(OFFLINE_DOCUMENT)); return; }
  event.respondWith(APP_SHELL_URLS.has(url.href) ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, fallbackUrl = null) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  let networkError;
  try {
    response = await fetch(request);
    if (response && response.ok) { await cache.put(request, response.clone()); return response; }
  } catch (error) { networkError = error; }
  const cached = await cache.match(request);
  if (cached) return cached;
  if (fallbackUrl) { const fallback = await cache.match(fallbackUrl); if (fallback) return fallback; }
  if (response) return response;
  throw networkError;
}
