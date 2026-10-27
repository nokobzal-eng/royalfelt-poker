// Minimal service worker so phones offer "Add to Home Screen". Always goes to the network: the game is live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
