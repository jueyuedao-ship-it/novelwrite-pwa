'use strict';

const CACHE_NAME = 'fumizukue-0f5585499dc8';
const SCOPE = self.registration.scope;
const SCOPE_URL = new URL(SCOPE);
const shellUrl = path => new URL(path, SCOPE).href;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './model.js',
  './core.js',
  './editor-state.js',
  './migration.js',
  './package.js',
  './storage.js',
  './images.js',
  './archive.js',
  './vendor/fflate.mjs',
  './plot.js',
  './characters.js',
  './app.js',
  './workspace-loader.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
].map(shellUrl);

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
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('fumizukue-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // A project site on GitHub Pages normally lives under /<repository>/.
  // Only handle requests inside this Service Worker's own scope.
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, OFFLINE_DOCUMENT));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function networkFirst(request, fallbackUrl = null) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }

    throw error;
  }
}
