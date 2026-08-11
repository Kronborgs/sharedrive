// Sharedrive Service Worker
// Provides app-shell caching for PWA installability and offline resilience.
// Does NOT cache private user file data — only static assets and the app shell.

const CACHE_NAME = 'sharedrive-shell-v4'

// App shell: the minimal set of assets needed to render the UI.
// Vite-built assets have content hashes in filenames, so they are safe to
// cache aggressively — a new build produces new URLs and the old cache
// entries simply expire.
const SHELL_ASSETS = [
  '/',
  '/site.webmanifest',
  '/notes.webmanifest',
  '/notes-icon-192.png',
  '/notes-icon-512.png',
]

// Patterns that should NEVER be cached (sensitive / dynamic data):
const NO_CACHE_PATTERNS = [
  /^\/api\//,
  /^\/upload\//,
  /^\/dav\//,
  /^\/preview\//,
  /^\/api\/v1\/files\/.*\/content/,
]

// Static asset extensions that are safe to cache at runtime
const CACHEABLE_ASSET_RE = /\.(js|css|woff2?|ttf|png|svg|ico|jpg|jpeg|webp|avif|json)(\?.*)?$/i

const SHARE_CACHE = 'sharedrive-share-target'

// ── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  )
})

// ── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const keep = new Set([CACHE_NAME, SHARE_CACHE])
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !keep.has(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

// ── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GET requests
  if (url.origin !== self.location.origin) return
  if (request.method !== 'GET') return

  // Never cache sensitive/dynamic paths
  const path = url.pathname
  if (NO_CACHE_PATTERNS.some((re) => re.test(path))) return

  // Navigation requests (HTML pages): network-first with shell fallback.
  // This ensures logged-out users always get the server redirect, but if
  // offline the cached shell can still render the login page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache a fresh copy of the shell
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/', clone))
          return response
        })
        .catch(() => caches.match('/').then((r) => r || new Response('Offline', { status: 503 })))
    )
    return
  }

  // Static assets (JS, CSS, fonts, images): cache-first.
  // Vite-built assets have content hashes, so stale entries are harmless.
  if (CACHEABLE_ASSET_RE.test(path)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
      })
    )
    return
  }
})

// ── Share Target ────────────────────────────────────────────────────────────
// When the user shares files to Sharedrive from Android, the OS POSTs to
// /share-target. The SW intercepts this, stashes the files in a temporary
// cache, and redirects to the app where the React code picks them up.

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Keep legacy '/share-target' for older installs while supporting the
  // scoped Files-PWA action '/files/share-target'.
  if ((url.pathname === '/files/share-target' || url.pathname === '/share-target') && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData()
        const files = formData.getAll('files')

        if (files.length > 0) {
          // Store files in a temporary cache so the page can pick them up
          const cache = await caches.open(SHARE_CACHE)
          const filesData = []
          for (const file of files) {
            if (file instanceof File) {
              filesData.push({ name: file.name, type: file.type, size: file.size })
              await cache.put(
                `/share-target-file/${file.name}`,
                new Response(file, {
                  headers: { 'Content-Type': file.type || 'application/octet-stream' },
                })
              )
            }
          }
          // Store manifest of shared files
          await cache.put(
            '/share-target-manifest',
            new Response(JSON.stringify(filesData), {
              headers: { 'Content-Type': 'application/json' },
            })
          )
        }

        // Redirect to the files page where the app will detect shared files
        return Response.redirect('/files?share-target=1', 303)
      })()
    )
    return
  }
})
