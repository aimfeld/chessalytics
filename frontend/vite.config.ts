/// <reference types="vitest/config" />
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { vitePrerenderPlugin } from 'vite-prerender-plugin'

// Social media crawlers aggressively cache OG images by URL. Appending a
// content hash as a query string forces re-fetch when the image changes.
function ogImageHashPlugin(): Plugin {
  return {
    name: 'og-image-hash',
    apply: 'build',
    transformIndexHtml(html) {
      const content = fs.readFileSync(path.resolve(__dirname, 'public/og-image.jpg'))
      const hash = createHash('md5').update(content).digest('base64url').slice(0, 8)
      return html.replaceAll('og-image.jpg', `og-image.jpg?v=${hash}`)
    },
  }
}

// vite-prerender-plugin dynamically imports the prerender entry at build time.
// The loaded module graph (React, source-map WASM) keeps Node alive after the
// build finishes. Force exit once all plugins (including VitePWA) are done.
function forceExitAfterBuild(): Plugin {
  return {
    name: 'force-exit-after-build',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      setTimeout(() => process.exit(0), 100)
    },
  }
}

// Single source of truth for both server.headers/preview.headers (the 200-path
// second line of defense, quick 260906-p54) and crossOriginIsolationPlugin
// below (the 304-path fix, since server.headers is a 200-only mechanism).
const CROSS_ORIGIN_ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// server.headers/preview.headers only apply on the 200 path. Dev sends
// Cache-Control: no-cache, so every second load of a given URL revalidates
// (304 Not Modified), and WebKit refuses to run a worker script whose 304
// response lacks COEP (WebKit bug 245346) — this killed the SECOND Stockfish
// pool worker (same glue URL as the first) within ~10 ms with a bare `error`
// Event, while workers loaded from distinct URLs started fine. Prod is
// unaffected: Caddy's `header` directive does emit on 304s too. This plugin
// sets both headers on every response, 200 or 304, closing that gap for dev
// and `vite preview`.
function crossOriginIsolationPlugin(): Plugin {
  const attachHeaders = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
        res.setHeader(name, value)
      }
      next()
    })
  }
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      attachHeaders(server)
    },
    configurePreviewServer(server) {
      attachHeaders(server)
    },
  }
}

// Vitest ceilings. These are NOT budgets: a passing test never waits for them,
// only a hung or failing one does, so raising them costs nothing on the happy
// path. Vitest's 5s default sits within one CPU-contention spike of the
// whole-page mounts (Train, Analysis, Bots) and the openings.tsv replay, all of
// which run ~4-5s under the full parallel `vitest run` on a loaded box and
// then fail with a bare "Test timed out in 5000ms" even though nothing is
// wrong. Per-file `}, 15000)` band-aids kept recurring for each new heavy
// test; one project-wide ceiling ends that. testing-library's `waitFor` has an
// independent 1000ms ceiling, raised in src/vitest.setup.ts for the same reason.
const TEST_TIMEOUT_MS = 20_000
const HOOK_TIMEOUT_MS = 30_000

// https://vite.dev/config/
export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    setupFiles: ['src/vitest.setup.ts'],
  },
  envDir: path.resolve(__dirname, '..'), // Load .env from project root
  optimizeDeps: {
    // Prevent Vite's esbuild optimizer from relocating the stockfish/onnxruntime-web
    // package JS to .vite/deps/, which would break their relative WASM paths.
    // Runtime assets live in public/engine/ and public/maia/ and are served verbatim.
    exclude: ['stockfish', 'onnxruntime-web'],
  },
  plugins: [
    crossOriginIsolationPlugin(),
    ogImageHashPlugin(),
    react(),
    tailwindcss(),
    vitePrerenderPlugin({
      renderTarget: '#root',
      prerenderScript: path.resolve(__dirname, 'src/prerender.tsx'),
      additionalPrerenderRoutes: ['/privacy'],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true },
      manifest: {
        name: 'FlawChess',
        short_name: 'FlawChess',
        description: 'Find and fix the flaws in your game. Free full-game analysis of every chess.com and lichess game: tactics, openings, endgames, and time management.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        importScripts: ['/push-sw.js'],
        // SPA fallback is handled by Caddy in prod (try_files /index.html) and by
        // the NetworkFirst navigation route below. Keep navigateFallback null so the
        // SW never blindly serves index.html for backend navigations such as the
        // OAuth callback /api/auth/google/callback (commit b953abad).
        navigateFallback: null,
        // Bug fix: installed Android PWAs launched a many-deploys-old layout because
        // the SW precached index.html and served it cache-first for navigations to `/`
        // (Workbox default directoryIndex resolves `/` -> precached index.html).
        // Excluding ALL HTML from the precache removes that stale-shell route; the shell
        // is instead served NetworkFirst below (fresh when online, cached when offline).
        // WASM stays excluded too (iOS Cache API ~50 MB limit) — HTTP cache handles it.
        // The Maia ONNX model (public/maia/*.onnx, ~44 MB) is likewise excluded from the
        // precache manifest — it alone exceeds the iOS Cache API limit; the onnxruntime-web
        // runtime (ort-wasm-simd-threaded.wasm) is already covered by the **/*.wasm entry.
        // maia/** and engine/** (quick 260905-rhc): every vendored engine asset under these
        // two prefixes is now requested through a `?v=<n>` query (versionedEngineAssetUrl,
        // see engineAssetCache.ts), but Workbox's precache route only strips utm_*/fbclid
        // when MATCHING a request against the manifest — it never matches a versioned
        // request against a manifest entry keyed on the bare path. Precaching those
        // ~245 KB of *.js/*.mjs entries under their unversioned URLs would therefore add
        // install cost for entries nothing can ever request again; there is no
        // runtimeCaching route matching these prefixes either, so the versioned requests
        // simply go to the network instead.
        globIgnores: ['**/*.wasm', '**/*.html', '**/*.onnx', 'maia/**', 'engine/**'],
        runtimeCaching: [
          {
            // Backend: never cached, always network. Registered FIRST so /api/*
            // navigations (Google OAuth callback) are handled here, not by the
            // navigation route below.
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            // App-shell navigations: always fetch fresh index.html when online so the
            // document references the current hashed /assets/*; fall back to the last
            // cached shell only when the network is unreachable (true offline). No
            // networkTimeoutSeconds — a timeout would reintroduce a staleness window
            // where a slow-but-online resume serves an old shell referencing deleted
            // hashed assets (404s).
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' && !url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-shell',
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
    // Must be AFTER VitePWA so its closeBundle runs after SW generation
    forceExitAfterBuild(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    hmr: {
      clientPort: process.env.TUNNEL ? 443 : undefined,
    },
    allowedHosts: process.env.TUNNEL ? true : ['.ts.net'],
    proxy: {
      '/api': 'http://localhost:8000',
    },
    // Phase 219 (D-05): dev must be cross-origin isolated identically to prod
    // (Caddy) and `vite preview` (below), so `self.crossOriginIsolated` is
    // `true` in every environment and the Maia worker's thread-count formula
    // (maia-worker.js's chooseWasmThreadCount()) behaves the same everywhere.
    // Applied only on the 200 path (a Vite/connect limitation); a second line
    // of defense alongside crossOriginIsolationPlugin() above, which also
    // covers the 304 path (quick 260906-p54).
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  preview: {
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
})
