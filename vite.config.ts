import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves this repo from /workout-tracker/. Cloudflare serves it
// from the root of its own domain. Cloudflare Pages builds set CF_PAGES=1 and
// Workers Builds set WORKERS_CI=1, so we can pick the right base automatically
// without a second config.
const onCloudflare = process.env.CF_PAGES || process.env.WORKERS_CI
const base = onCloudflare ? '/' : '/workout-tracker/'

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Workout Tracker',
        short_name: 'Workout',
        description: 'Offline-first workout logging with Dropbox sync and AI insights',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
})
