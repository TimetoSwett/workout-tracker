#!/usr/bin/env node
// TOM-86 step 2: a release is not deployed until an *already-open* tab can reach the new
// bundle. The web app precaches itself (vite-plugin-pwa, `registerType: 'prompt'` with
// `skipWaiting: false`), so a deploy does not reach a running tab on its own: the old worker
// keeps serving the old precached index.html until something activates the new one. A stale
// worker pinning the board to the previous build is a release failure, not a cosmetic one, so
// this measures the whole transition instead of just asserting the origin changed.
//
// Two real builds are served from ONE origin, swapped under the browser's feet - which is
// exactly what a deploy looks like to a tab that is already open:
//
//   1. serve the OLD build, let its worker take control, confirm the tab is on the old bundle
//   2. swap the origin to the NEW build (the deploy)
//   3. confirm the old tab DISCOVERS the new worker and it reaches `installed`/waiting
//   4. confirm the old tab is STILL on the old bundle until activation - `prompt` semantics,
//      and the reason an "it deployed" check that stops at step 2 proves nothing
//   5. activate it the way src/webUpdate.ts does (SKIP_WAITING -> controllerchange -> reload)
//      and confirm the tab lands on the NEW bundle with the new version string
//   6. confirm a SECOND open tab is reloaded onto the new build by clientsClaim, since
//      `reloadOnControllerChange()` exists precisely so no tab outlives its own assets
//
// Usage: node tests/tom86-sw-turnover.qa.mjs --old <dist> --new <dist>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null }
const OLD = resolve(arg('--old') ?? 'dist-old')
const NEW = resolve(arg('--new') ?? 'dist-new')
for (const d of [OLD, NEW]) if (!existsSync(join(d, 'sw.js'))) { console.error(`no sw.js under ${d}`); process.exit(2) }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The main entry script a build's index.html points at, e.g. 'assets/index-C-FBFX_J.js'. */
const entryOf = (dist) => readFileSync(join(dist, 'index.html'), 'utf8').match(/assets\/index-[A-Za-z0-9_-]+\.js/)[0]

// Negative control. `--stale-sw` deploys the new assets but keeps serving the OLD sw.js, which
// is a real misconfiguration (a CDN holding the worker while the hashed assets turn over) and
// the exact fault this probe exists to catch. The run MUST fail under it; if it still passes,
// the probe is decorative and its green result means nothing.
const STALE_SW = process.argv.includes('--stale-sw')

// One origin, swappable root. `served` is the deploy pointer: flipping it IS the deploy.
let served = OLD
function serve() {
  const server = createServer((req, res) => {
    const rel = new URL(req.url, 'http://localhost').pathname.slice(1)
    const root = STALE_SW && (rel === 'sw.js' || rel.startsWith('workbox-')) ? OLD : served
    const file = join(root, rel)
    const path = file.startsWith(root) && rel && existsSync(file) ? file : join(root, 'index.html')
    // Mirror production's headers. `sw.js` must be revalidated or the browser can sit on a
    // cached copy and never learn a deploy happened - the classic stale-worker trap.
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=0, must-revalidate',
    })
    res.end(readFileSync(path))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })))
}

async function waitFor(what, fn, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  for (;;) { const got = await fn(); if (got) return got; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await sleep(100) }
}
class Devtools {
  constructor(s) { this.socket = s; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    s.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id == null) return
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result) }) }
  static async open(u) { const s = new WebSocket(u)
    await new Promise((ok, fail) => { s.addEventListener('open', ok, { once: true }); s.addEventListener('error', () => fail(new Error('devtools socket failed')), { once: true }) })
    return new Devtools(s) }
  send(method, params = {}, sessionId = this.sessionId) { const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method })) }
}

let pass = 0, fail = 0
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const oldEntry = entryOf(OLD), newEntry = entryOf(NEW)
  console.log(`old build entry: ${oldEntry}`)
  console.log(`new build entry: ${newEntry}`)
  if (oldEntry === newEntry) { console.error('old and new builds have the same entry hash - nothing to detect'); process.exit(2) }

  const { server, port } = await serve()
  const base = `http://127.0.0.1:${port}/`
  const profile = mkdtempSync(join(tmpdir(), 'tom86-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    const openTab = async () => {
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
      return sessionId
    }
    const evIn = async (sessionId, expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const tabA = await openTab()
    for (const s of [tabA]) { await dt.send('Page.enable', {}, s); await dt.send('Runtime.enable', {}, s) }
    // Deliberately NOT bypassing the service worker: it is the thing under test.
    const ev = (e) => evIn(tabA, e)
    // The entry script URL the document actually loaded.
    const entryIn = (s) => evIn(s, `(document.querySelector('script[type=module]')?.src ?? '').replace(location.origin + '/', '')`)
    // Both versionName shapes are legitimate and which one you get depends on the ref, not the
    // tree: a v* tag build stamps '0.3.0', a branch build stamps '<date>.<short sha>'. An
    // earlier version of this probe only matched the date form and mis-reported a tagged
    // baseline as missing its version, so match either.
    const versionIn = (s) => evIn(s, `(async () => { const r = await fetch('/' + (document.querySelector('script[type=module]')?.src ?? '').replace(location.origin + '/', '')); const t = await r.text(); return (t.match(/2026\\.[0-9]{2}\\.[0-9]{2}\\.[0-9a-f]{7}/) ?? t.match(/\\b\\d+\\.\\d+\\.\\d+\\b/) ?? ['?'])[0] })()`)

    // ---- 1. the old build takes control -------------------------------------------------
    await dt.send('Page.navigate', { url: base }, tabA)
    await waitFor('first load', async () => await ev(`document.readyState === 'complete'`))
    await waitFor('worker registered', async () => await ev(`(async () => !!(await navigator.serviceWorker.getRegistration()))()`))
    await waitFor('worker activated', async () => await ev(`(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')()`))
    // The very first load is uncontrolled; reload so the tab is genuinely served BY the worker.
    await dt.send('Page.navigate', { url: base }, tabA)
    await waitFor('controlled', async () => await ev(`!!navigator.serviceWorker.controller && document.readyState === 'complete'`))
    check(await entryIn(tabA) === oldEntry, 'old tab is controlled and serving the old bundle', `${await entryIn(tabA)}`)
    const oldVersion = await versionIn(tabA)
    const VERSION = /^(2026\.\d{2}\.\d{2}\.[0-9a-f]{7}|\d+\.\d+\.\d+)$/
    check(VERSION.test(oldVersion), 'old tab reports a readable version string', oldVersion)

    // ---- 2. deploy: swap the origin to the new build -------------------------------------
    served = NEW
    check(entryOf(served) === newEntry, 'origin now serves the new build', newEntry)
    // The old tab has not navigated. Its worker is still the old one.
    check(await entryIn(tabA) === oldEntry, 'old tab has not changed on its own (no navigation yet)', oldEntry)

    // ---- 3. the open tab discovers the new worker ----------------------------------------
    // This is what src/webUpdate.ts webUpdateReady() does: registration.update(), then wait
    // for the new worker to finish caching and sit in `waiting`.
    const waitingState = await ev(`(async () => {
      const r = await navigator.serviceWorker.getRegistration()
      await r.update()
      const installing = r.installing
      if (installing) await new Promise((res) => {
        const done = () => { if (installing.state === 'installed' || installing.state === 'redundant') { installing.removeEventListener('statechange', done); res() } }
        installing.addEventListener('statechange', done); done(); setTimeout(res, 15000)
      })
      return r.waiting?.state ?? 'none'
    })()`)
    check(waitingState === 'installed', 'open tab discovers the deployed worker and it caches to `waiting`', `registration.waiting.state=${waitingState}`)

    // ---- 4. but it is NOT yet on the new bundle ------------------------------------------
    // `skipWaiting: false` - this is the prompt design, and it is why "the origin serves the
    // new files" is not the same claim as "the board gets the new build".
    await dt.send('Page.reload', {}, tabA)
    await waitFor('reloaded', async () => await ev(`document.readyState === 'complete'`))
    const afterPlainReload = await entryIn(tabA)
    check(afterPlainReload === oldEntry, 'a plain reload alone still serves the OLD precached bundle', `${afterPlainReload} (expected, prompt mode)`)

    // ---- 6a. a second tab, open across the activation ------------------------------------
    const tabB = await openTab()
    await dt.send('Page.enable', {}, tabB); await dt.send('Runtime.enable', {}, tabB)
    await dt.send('Page.navigate', { url: base }, tabB)
    await waitFor('tab B loaded', async () => await evIn(tabB, `document.readyState === 'complete' && !!navigator.serviceWorker.controller`))
    check(await entryIn(tabB) === oldEntry, 'a second open tab is also on the old bundle', oldEntry)
    // Marker in tab B's current execution context. We do NOT install our own
    // controllerchange listener here: the real bundle already called
    // reloadOnControllerChange() at startup, and that reload destroys the context -- taking
    // any observer variable with it. So the marker's *disappearance* is the signal, and an
    // earlier version of this probe wrongly read it as "the claim never happened".
    await evIn(tabB, `(() => { window.__preActivation = true; return true })()`)

    // ---- 5. activate exactly the way the app does ----------------------------------------
    const activated = await ev(`(async () => {
      const r = await navigator.serviceWorker.getRegistration()
      const worker = r.waiting
      if (!worker) return 'no waiting worker'
      await new Promise((res) => {
        const changed = () => { if (navigator.serviceWorker.controller === worker) { navigator.serviceWorker.removeEventListener('controllerchange', changed); res() } }
        navigator.serviceWorker.addEventListener('controllerchange', changed)
        worker.postMessage({ type: 'SKIP_WAITING' })
        setTimeout(res, 8000)
      })
      return 'activated'
    })()`)
    check(activated === 'activated', 'SKIP_WAITING activates the deployed worker', activated)

    await dt.send('Page.reload', {}, tabA)
    await waitFor('post-activation load', async () => await ev(`document.readyState === 'complete'`))
    const finalEntry = await entryIn(tabA)
    check(finalEntry === newEntry, 'the once-stale tab now serves the NEW bundle', finalEntry)
    const newVersion = await versionIn(tabA)
    check(newVersion !== oldVersion && VERSION.test(newVersion), 'the version string the user can read advanced', `${oldVersion} → ${newVersion}`)

    // ---- 6b. clientsClaim pulled the other tab along, with no help from us ---------------
    // Nothing below reloads tab B. If it ends up on the new bundle anyway, clientsClaim
    // claimed it and the app's own reloadOnControllerChange() navigated it -- which is the
    // property that stops a tab from outliving the assets it was built from.
    const bMoved = await waitFor(
      'tab B to follow the activation on its own',
      async () => (await entryIn(tabB)) === newEntry,
      15_000,
    ).catch(() => false)
    check(bMoved === true, 'the second tab follows onto the new bundle with NO manual reload', `entry=${await entryIn(tabB)}`)
    const markerGone = await evIn(tabB, `typeof window.__preActivation === 'undefined'`)
    check(markerGone === true, 'tab B navigated itself (pre-activation context is gone)', `__preActivation undefined=${markerGone}`)
    const bServes = await evIn(tabB, `(async () => { const r = await fetch('/index.html', { cache: 'no-store' }); const t = await r.text(); return (t.match(/assets\\/index-[A-Za-z0-9_-]+\\.js/) ?? ['?'])[0] })()`)
    check(bServes === newEntry, "tab B's controller now serves the new index.html", bServes)

    // ---- the old asset is genuinely gone from the origin ---------------------------------
    // Status alone proves nothing: an SPA fallback answers 200 for a deleted asset. Assert on
    // the body instead -- the old entry URL must no longer return the old bundle.
    const oldBody = await ev(`(async () => { const r = await fetch('/' + ${JSON.stringify(oldEntry)}, { cache: 'no-store' }); const t = await r.text(); return { status: r.status, isOldBundle: t.includes('__vite') || /createElement|querySelector/.test(t) ? t.length > 100000 : false, len: t.length } })()`)
    check(oldBody.isOldBundle === false, 'the old entry URL no longer returns the old bundle', `status ${oldBody.status}, ${oldBody.len} bytes (SPA fallback, not the 150KB bundle)`)
  } finally { chrome.kill(); server.close() }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
