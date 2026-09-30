import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

// Single source of truth for the app version (TOM-2). `package.json` feeds both
// this define and android/app/build.gradle's versionName/versionCode, so the
// string the app shows can never drift from the artifact it is running.
const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// GitHub Pages serves this repo from /workout-tracker/. Cloudflare serves it
// from the root of its own domain: Cloudflare Pages builds set CF_PAGES=1 and
// Workers Builds set WORKERS_CI=1. The Android app (via Capacitor) serves it
// from the WebView root and builds with --mode capacitor. All of those need
// base '/'.
export default defineConfig(({ mode }) => ({
  base: process.env.CF_PAGES || process.env.WORKERS_CI || mode === 'capacitor' ? '/' : '/workout-tracker/',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
}))
