import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { defineConfig, type Plugin } from 'vite'
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

// https://vite.dev/config/
export default defineConfig({
  envDir: path.resolve(__dirname, '..'), // Load .env from project root
  optimizeDeps: {
    // Prevent Vite's esbuild optimizer from relocating the stockfish/onnxruntime-web
    // package JS to .vite/deps/, which would break their relative WASM paths.
    // Runtime assets live in public/engine/ and public/maia/ and are served verbatim.
    exclude: ['stockfish', 'onnxruntime-web'],
  },
  plugins: [
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
        globIgnores: ['**/*.wasm', '**/*.html', '**/*.onnx'],
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
  },
})
