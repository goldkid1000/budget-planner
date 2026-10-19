/* Budget Planner service worker v2.0.4 — cache-first app shell, versioned cache.
   version.json / changelog.json are network-first so update checks always
   see the newest version. Offline, navigations fall back to the cached shell. */
'use strict';

var CACHE = 'budget-planner-v2.1.0';
var SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.json',
  'icons/icon.svg'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    /* v2.0.4 hot-fix: bypass the HTTP cache when priming the new cache.
       Plain addAll() can pull STALE files out of the HTTP cache into the new
       versioned cache — new cache name, old files inside. {cache:'reload'}
       forces every shell file to come from the network. */
    caches.open(CACHE).then(function(cache){
      return cache.addAll(SHELL.map(function(u){ return new Request(u, { cache: 'reload' }); }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var url = new URL(event.request.url);
  if(event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  /* version files: network-first, fall back to cache */
  if(url.pathname.endsWith('version.json') || url.pathname.endsWith('changelog.json')){
    event.respondWith(
      fetch(event.request).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(cache){ cache.put(event.request, copy); });
        return res;
      }).catch(function(){ return caches.match(event.request); })
    );
    return;
  }

  /* app shell: cache-first, fall back to network, then cached index for pages */
  event.respondWith(
    caches.match(event.request).then(function(cached){
      if(cached) return cached;
      return fetch(event.request).then(function(res){
        if(res && res.status === 200){
          var copy = res.clone();
          caches.open(CACHE).then(function(cache){ cache.put(event.request, copy); });
        }
        return res;
      }).catch(function(){
        if(event.request.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
