#!/usr/bin/env node
// TOM-64 focused probe: is the landscape + on-screen-keyboard failure caused by the
// always-reserved 59px timer strip, and can the user recover by scrolling?
//
// Measures, at 844x390 shrunk to a keyboard-sized viewport:
//   - usable set-editor height with rest IDLE vs rest RUNNING
//   - whether the focused weight input is visible, and whether scrolling the log-scroll
//     container can bring it fully into view (the real recovery path on a device)
//   - how many set rows fit at all
//
// Synthetic data only. Usage: node landscape-keyboard.mjs <dist-dir> <label>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const LABEL = process.argv[3] ?? 'candidate'
const OUT = process.env.OUT ? resolve(process.env.OUT) : mkdtempSync(join(tmpdir(), 'tom64-landscape-'))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitFor(what, fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}
function builtBasePath() { return readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/' }
function serveDist(basePath) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const rel = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname.slice(1)
    const file = join(DIST, rel || 'index.html')
    const path = file.startsWith(DIST) && existsSync(file) && rel ? file : join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(readFileSync(path))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })))
}
class Devtools {
  constructor(socket) { this.socket = socket; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id == null) return
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result) }) }
  static async open(u) { const s = new WebSocket(u)
    await new Promise((ok, no) => { s.addEventListener('open', ok, { once: true }); s.addEventListener('error', () => no(new Error('ws')), { once: true }) })
    return new Devtools(s) }
  send(method, params = {}, sessionId = this.sessionId) { const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method })) }
}

const LONG_NAME = 'Seated Incline Dumbbell Press (Neutral Grip, Paused at Bottom) — Machine #4'
const KEYBOARD_FRACTIONS = [0.4, 0.45, 0.5]

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom64-chrome-'))
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
    const setViewport = (w, h) => dt.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true })
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const shot = async (label) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT, `${LABEL}-${label}.png`), Buffer.from(data, 'base64'))
    }

    await setViewport(844, 390)
    await dt.send('Page.navigate', { url: base })
    await waitFor('paint', async () => await evaluate(`!!document.querySelector('.app')`))
    await evaluate(`(() => {
      const now = Date.now()
      localStorage.setItem('wt.active.v1', JSON.stringify({
        active: { id: 'qa-active', date: new Date(now).toISOString().slice(0,10), startedAt: now - 11*60000,
          name: 'QA Synthetic Session',
          exercises: [
            { id:'ex1', name: ${JSON.stringify(LONG_NAME)}, sets: [ {weight:135,reps:8,done:false},{weight:135,reps:8,done:false},{weight:135,reps:8,done:false} ] },
            { id:'ex2', name:'Cable Row', sets: [ {weight:90,reps:10,done:false},{weight:90,reps:10,done:false} ] } ] },
        templates: [], settings: { units:'lbs', restSeconds:90, philosophy:'balanced' } }))
      localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
    })()`)
    await dt.send('Page.navigate', { url: base })
    await waitFor('log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))

    const probe = () => evaluate(`(() => {
      const el = document.activeElement
      const b = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null
      const sc = document.querySelector('.log-scroll')
      const scr = sc?.getBoundingClientRect() ?? null
      const t = document.querySelector('.rest-timer')?.getBoundingClientRect() ?? null
      const bar = document.querySelector('.tabbar')?.getBoundingClientRect() ?? null
      const hit = (r) => r && b && b.top < r.bottom && b.bottom > r.top && b.left < r.right && b.right > r.left
      return {
        innerHeight: window.innerHeight,
        timerPresent: !!t, timerHeight: t ? +t.height.toFixed(1) : null,
        scrollTop: sc?.scrollTop ?? null, scrollHeight: sc?.scrollHeight ?? null,
        editorHeight: scr ? +scr.height.toFixed(1) : null,
        focusedIsSetInput: !!el?.classList?.contains('set-input'),
        inputTop: b ? +b.top.toFixed(1) : null, inputBottom: b ? +b.bottom.toFixed(1) : null,
        visible: b ? (b.top >= -1 && b.bottom <= window.innerHeight + 1) : null,
        coveredByTimer: hit(t), coveredByTabbar: hit(bar),
        tabbarTop: bar ? +bar.top.toFixed(1) : null,
        restTime: document.querySelector('.rest-time')?.textContent ?? null,
      }
    })()`)

    const rows = []
    for (const resting of [false, true]) {
      if (resting) {
        await evaluate(`document.querySelectorAll('.exercise-card')[0].querySelector('.set-row:not(.set-labels) .icon-btn').click()`)
        await waitFor('resting', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
      }
      for (const frac of KEYBOARD_FRACTIONS) {
        await setViewport(844, 390)
        await sleep(250)
        // focus the LAST set input of the last exercise: the worst case the user types into
        await evaluate(`(() => {
          const cards = document.querySelectorAll('.exercise-card')
          const rows = cards[cards.length-1].querySelectorAll('.set-row:not(.set-labels)')
          const i = rows[rows.length-1].querySelectorAll('.set-input')[0]
          i.scrollIntoView({ block: 'center' }); i.focus(); return true })()`)
        await sleep(200)
        await setViewport(844, 390 - Math.round(390 * frac))
        await sleep(500)
        const before = await probe()
        // the real recovery path: can scrolling the editor bring the input fully into view?
        await evaluate(`document.activeElement.scrollIntoView({ block: 'center' })`)
        await sleep(300)
        const after = await probe()
        await shot(`${resting ? 'resting' : 'idle'}-kb${Math.round(frac * 100)}`)
        rows.push({ label: LABEL, resting, keyboardPct: frac * 100, before, after })
        console.log(`${LABEL} ${resting ? 'RESTING' : 'IDLE   '} kb${Math.round(frac*100)}%  vh=${before.innerHeight} timer=${before.timerHeight ?? 'absent'} editor=${before.editorHeight} input=${before.inputTop}–${before.inputBottom} visible=${before.visible} coveredByTabbar=${before.coveredByTabbar} | after scrollIntoView: input=${after.inputTop}–${after.inputBottom} visible=${after.visible} coveredByTabbar=${after.coveredByTabbar}`)
      }
    }
    writeFileSync(join(OUT, `${LABEL}-landscape-keyboard.json`), JSON.stringify(rows, null, 2))
    console.log(`\nevidence: ${OUT}`)
  } finally { chrome.kill(); server.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
