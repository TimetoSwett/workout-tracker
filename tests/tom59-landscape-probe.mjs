#!/usr/bin/env node
// Diagnostic probe for the one TOM-59 failure: a focused weight input sitting under the tab
// bar in landscape with the on-screen keyboard open. Answers three questions the pass/fail
// check cannot: does the .app box track the shrunken visual viewport, is the field merely
// un-scrolled (reachable) or genuinely unreachable, and does it reproduce in portrait?
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom59-probe-'))
mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const basePathOf = () => readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/'
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
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitFor(what, fn, timeoutMs = 15_000) {
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

const CASES = [
  { name: 'landscape', width: 844, height: 390, keyboard: 176 },
  { name: 'portrait', width: 390, height: 844, keyboard: 380 },
  { name: 'portrait-tall-keyboard', width: 390, height: 844, keyboard: 500 },
]

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom59-probe-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    for (const c of CASES) {
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
      dt.sessionId = sessionId
      await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })
      const vp = (w, h) => dt.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true })
      await vp(c.width, c.height)
      const ev = async (expression) => {
        const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
        return result.value
      }
      await dt.send('Page.navigate', { url: base })
      await waitFor('paint', async () => await ev(`!!document.querySelector('.app')`))
      await ev(`(() => { const now = Date.now()
        localStorage.setItem('wt.active.v1', JSON.stringify({ active: { id: 'p', date: new Date(now).toISOString().slice(0,10), startedAt: now - 600000, name: 'Probe',
          restEndsAt: now + 120000, restTotal: 120,
          exercises: [ { id: 'a', name: 'Bench Press', sets: [ { weight: 135, reps: 8, done: true }, { weight: 135, reps: 8, done: false } ] },
            { id: 'b', name: 'Cable Row', sets: [ { weight: 90, reps: 10, done: false }, { weight: 90, reps: 10, done: false } ] },
            { id: 'c', name: 'Lateral Raise', sets: [ { weight: 20, reps: 15, done: false } ] } ] },
          templates: [], settings: { units: 'lbs', restSeconds: 120, philosophy: 'balanced' } }))
        localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] })); return true })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('log', async () => await ev(`!!document.querySelector('.active-log .set-input')`))

      // Focus the LAST set input — the worst case, furthest down the scroll container.
      await ev(`(() => { const all = [...document.querySelectorAll('.set-input')]; const i = all[all.length - 2]
        i.scrollIntoView({ block: 'center' }); i.focus(); return true })()`)
      await vp(c.width, c.height - c.keyboard)
      await sleep(800)

      const snapshot = (label) => ev(`(() => {
        const r = (s) => { const el = typeof s === 'string' ? document.querySelector(s) : s; if (!el) return null
          const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), height: +b.height.toFixed(1) } }
        const el = document.activeElement
        const sc = document.querySelector('.log-scroll')
        return { label: ${JSON.stringify(label)}, innerHeight: window.innerHeight,
          visualViewportHeight: window.visualViewport ? +window.visualViewport.height.toFixed(1) : null,
          appInlineHeight: document.querySelector('.app')?.style.height || null,
          app: r('.app'), main: r('main'), activeLog: r('.active-log'), timer: r('.rest-timer'), scroll: r('.log-scroll'), tabbar: r('.tabbar'),
          scrollState: sc ? { scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, canScroll: sc.scrollHeight > sc.clientHeight } : null,
          focused: { isSetInput: el?.classList?.contains('set-input') ?? false, rect: r(el) },
          focusedVisible: (() => { const b = el.getBoundingClientRect(); return b.top >= -1 && b.bottom <= window.innerHeight + 1 })(),
        } })()`)

      const before = await snapshot('keyboard open, as the app left it')
      // Now try what a user would do: scroll the set editor to bring the field up.
      const afterScroll = await ev(`(() => { const el = document.activeElement
        el.scrollIntoView({ block: 'center' }); return true })()`).then(() => sleep(500)).then(() => snapshot('after scrollIntoView'))
      // And try scrolling the inner container to its maximum.
      const afterMax = await ev(`(() => { const sc = document.querySelector('.log-scroll'); sc.scrollTop = sc.scrollHeight; return true })()`)
        .then(() => sleep(400)).then(() => snapshot('after scrolling .log-scroll to the end'))

      const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT, `probe-${c.name}.png`), Buffer.from(data, 'base64'))

      console.log(`\n==== ${c.name} (${c.width}x${c.height}, keyboard ${c.keyboard}px -> viewport ${c.height - c.keyboard}px) ====`)
      for (const s of [before, afterScroll, afterMax]) console.log(JSON.stringify(s, null, 2))

      await dt.send('Target.closeTarget', { targetId }, undefined)
      dt.sessionId = undefined
    }
  } finally { chrome.kill(); server.close() }
  console.log(`\nscreenshots: ${OUT}`)
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
