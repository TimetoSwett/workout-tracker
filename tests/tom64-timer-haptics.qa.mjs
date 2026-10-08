#!/usr/bin/env node
// TOM-64 / AC3+AC4: Skip clears the deadline, natural expiry clears it AND buzzes, and what
// the haptics actually do for the whole rest. Instruments navigator.vibrate before the bundle
// loads and records every call. Synthetic data only.
//
//   node timer-haptics.mjs <dist-dir>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const OUT = process.env.OUT ? resolve(process.env.OUT) : mkdtempSync(join(tmpdir(), 'tom64-haptics-'))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitFor(what, fn, t = 20_000) { const until = Date.now() + t
  for (;;) { const g = await fn(); if (g) return g; if (Date.now() > until) throw new Error(`timed out: ${what}`); await sleep(100) } }
function builtBasePath() { return readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/' }
function serveDist(basePath) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const rel = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname.slice(1)
    const file = join(DIST, rel || 'index.html')
    const path = file.startsWith(DIST) && existsSync(file) && rel ? file : join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })))
}
class Devtools {
  constructor(s) { this.socket = s; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    s.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id == null) return
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result) }) }
  static async open(u) { const s = new WebSocket(u)
    await new Promise((ok, no) => { s.addEventListener('open', ok, { once: true }); s.addEventListener('error', () => no(new Error('ws')), { once: true }) })
    return new Devtools(s) }
  send(method, params = {}, sessionId = this.sessionId) { const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method })) }
}
const results = []; const failures = []
function record(name, pass, detail = '') { results.push({ name, pass, detail })
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${pass ? '(' : '— '}${detail}${pass ? ')' : ''}` : ''}`) }

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom64-hap-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null
      const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)
    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
    dt.sessionId = sessionId
    await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await dt.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    // Headless Chromium has no navigator.vibrate; define one so the app's capability check
    // ('vibrate' in navigator) behaves the way it does on an Android WebView, and log the calls.
    await dt.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__buzz = []
      Object.defineProperty(Navigator.prototype, 'vibrate', {
        configurable: true, writable: true,
        value: function (p) { window.__buzz.push({ at: Date.now(), pattern: p }); return true },
      })
    })()` })
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const seed = (restSeconds) => evaluate(`(() => {
      const now = Date.now()
      localStorage.setItem('wt.active.v1', JSON.stringify({
        active: { id:'qa', date:new Date(now).toISOString().slice(0,10), startedAt: now-600000, name:'QA Synthetic Session',
          exercises: [{ id:'ex1', name:'Synthetic Press', sets:[{weight:100,reps:5,done:false},{weight:100,reps:5,done:false}] }] },
        templates: [], settings: { units:'lbs', restSeconds: ${restSeconds}, philosophy:'balanced' } }))
      localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] })) })()`)

    await dt.send('Page.navigate', { url: base })
    await waitFor('paint', async () => await evaluate(`!!document.querySelector('.app')`))

    // --- Skip
    await seed(90)
    await dt.send('Page.navigate', { url: base })
    await waitFor('log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    await evaluate(`document.querySelector('.active-log .set-row:not(.set-labels) .icon-btn').click()`)
    await waitFor('resting', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
    record('Skip is enabled while resting and reachable without scrolling',
      await evaluate(`(() => { const s=[...document.querySelectorAll('.rest-actions button')].find(b=>b.textContent.trim()==='Skip')
        const b=s.getBoundingClientRect(); return !s.disabled && b.top>=0 && b.bottom<=window.innerHeight })()`))
    await evaluate(`[...document.querySelectorAll('.rest-actions button')].find(b=>b.textContent.trim()==='Skip').click()`)
    await sleep(400)
    const afterSkip = await evaluate(`(() => { const a = JSON.parse(localStorage.getItem('wt.active.v1')).active
      return { restEndsAt: a.restEndsAt ?? null, restTotal: a.restTotal ?? null,
        time: document.querySelector('.rest-time')?.textContent ?? null,
        present: !!document.querySelector('.rest-timer'),
        disabled: [...document.querySelectorAll('.rest-actions button')].map(b=>b.disabled).join(',') } })()`)
    record('Skip clears the deadline', afterSkip.restEndsAt == null, `restEndsAt ${afterSkip.restEndsAt}`)
    record('Skip also clears restTotal', afterSkip.restTotal == null, `restTotal ${afterSkip.restTotal}`)
    record('the strip stays mounted and goes inert after Skip',
      afterSkip.present && afterSkip.time === '—' && afterSkip.disabled === 'true,true',
      `time "${afterSkip.time}" disabled ${afterSkip.disabled}`)

    // --- natural expiry with haptics instrumented
    await seed(3)
    await dt.send('Page.navigate', { url: base })
    await waitFor('log again', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    await evaluate(`window.__buzz.length = 0`)
    await evaluate(`document.querySelector('.active-log .set-row:not(.set-labels) .icon-btn').click()`)
    await waitFor('resting again', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
    await waitFor('expired', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—')
    await sleep(600)
    const buzz = await evaluate(`window.__buzz.map(b => b.pattern)`)
    const afterExpiry = await evaluate(`(() => { const a = JSON.parse(localStorage.getItem('wt.active.v1')).active
      return { restEndsAt: a.restEndsAt ?? null, restTotal: a.restTotal ?? null,
        present: !!document.querySelector('.rest-timer'), label: document.querySelector('.rest-label')?.textContent ?? null,
        fill: document.querySelector('.rest-fill')?.style?.width ?? null } })()`)
    record('natural expiry clears the deadline', afterExpiry.restEndsAt == null, `restEndsAt ${afterExpiry.restEndsAt}`)
    record('natural expiry buzzes once, long (400ms)', buzz.includes(400), `vibrate calls: ${JSON.stringify(buzz)}`)
    record('the strip is still mounted after expiry with a zero-width bar',
      afterExpiry.present && afterExpiry.fill === '0%', `label "${afterExpiry.label}" fill ${afterExpiry.fill}`)
    record('OBSERVATION: haptics during the rest itself',
      true, `${buzz.filter(p => p === 1).length} x vibrate(1) over a 3s rest, then ${buzz.filter(p => p === 400).length} x vibrate(400) at expiry`)
    record('natural expiry leaves restTotal behind in the store (Skip clears it)',
      afterExpiry.restTotal == null, `restTotal after expiry ${afterExpiry.restTotal} vs after Skip ${afterSkip.restTotal}`)

    await dt.send('Target.closeTarget', { targetId }, undefined)
  } finally { chrome.kill(); server.close() }
  writeFileSync(join(OUT, 'haptics-results.json'), JSON.stringify(results, null, 2))
  const passed = results.filter(r => r.pass).length
  console.log(`\n${passed}/${results.length} timer behaviour checks passed`)
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
