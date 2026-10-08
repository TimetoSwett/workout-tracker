#!/usr/bin/env node
// TOM-80 delta probe: the consolidated v0.3.1 candidate carries two commits that both edit
// `src/index.css` — the TOM-73 rest-status/toast placement and the TOM-69 selected-tab
// indicator. The auto-merge is exactly how the TOM-73 defect (completion text landing over
// the set inputs at narrow widths) would come back.
//
// This measures the defect condition directly, at widths narrower than any existing probe
// covers (320px) and in both compact and non-compact logging, with the keyboard-shrunk
// viewport that triggered TOM-73 in the first place. Every number it prints is geometry, so
// the same script run against two builds diffs to nothing if the indicator moved nothing.
//
// Usage: npm run build && node tom80-css-interaction.qa.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first')
  process.exit(1)
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitFor(what, fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  for (;;) { const got = await fn(); if (got) return got; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await sleep(100) }
}
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

class Devtools {
  constructor(socket) {
    this.socket = socket; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id == null) return
      const entry = this.pending.get(msg.id); this.pending.delete(msg.id)
      if (!entry) return
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`)); else entry.resolve(msg.result)
    })
  }
  static async open(wsUrl) {
    const socket = new WebSocket(wsUrl)
    await new Promise((ok, fail) => {
      socket.addEventListener('open', ok, { once: true })
      socket.addEventListener('error', () => fail(new Error('devtools socket failed')), { once: true })
    })
    return new Devtools(socket)
  }
  send(method, params = {}, sessionId = this.sessionId) {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }
}

// Synthetic session only. No real body data anywhere in this probe.
const SEED = (restSeconds) => `(() => {
  const now = Date.now()
  localStorage.setItem('wt.active.v1', JSON.stringify({
    active: {
      id: 'qa-active', date: new Date(now).toISOString().slice(0, 10), startedAt: now - 11 * 60000,
      name: 'QA Delta Session',
      exercises: [{ id: 'ex1', name: 'Bench Press', sets: Array.from({ length: 12 }, () => ({ weight: 135, reps: 8, done: false })) }],
    },
    templates: [],
    settings: { units: 'lbs', restSeconds: ${restSeconds}, philosophy: 'balanced' },
  }))
  localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
})()`

const failures = []
function record(name, pass, detail) {
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const r2 = (n) => Math.round(n * 100) / 100

// 320px is narrower than any existing probe. The <=420px heights are the keyboard-shrunk
// viewports that put the app in `.logging.compact`, where TOM-69's change actually bites.
const VIEWPORTS = [
  [320, 400], // narrowest + compact: the worst case for both defects at once
  [320, 568], // narrowest realistic phone, non-compact
  [360, 420], // exactly on the compact boundary
  [360, 640], // common Android portrait
  [390, 844], // the board's portrait
]

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom80-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] })

  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const devtoolsPort = await waitFor('chromium devtools', () => {
      if (!existsSync(portFile)) return null
      const [line] = readFileSync(portFile, 'utf8').split('\n')
      return line && /^\d+$/.test(line) ? line : null
    })
    const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)
    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true })
    dt.sessionId = sessionId
    await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })

    const run = async (expression, userGesture = false) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const tap = (e) => run(e, true)

    // Reports every box the TOM-73 defect involved, plus the tab bar the TOM-69 rule touches.
    const MEASURE = `(() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: ${''}Math.round(r.x*100)/100, y: Math.round(r.y*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100, b: Math.round(r.bottom*100)/100 } }
      const status = document.querySelector('.rest-status')
      const inputs = [...document.querySelectorAll('.set-row:not(.set-labels) input')]
      const bar = document.querySelector('.tabbar')
      const btn = document.querySelector('.tabbar button')
      const active = document.querySelector('.tabbar button.active')
      const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      // The set inputs live inside '.log-scroll', which clips. An input scrolled out of view
      // still reports a rect outside the scroller, so raw overlap would flag content the user
      // cannot see. Clip each input to the scroller's own box first and keep only what is
      // actually on screen — that is the box a completion line or tab bar could really cover.
      const clip = (b, c) => {
        if (!b || !c) return null
        const x = Math.max(b.x, c.x), y = Math.max(b.y, c.y)
        const r = Math.min(b.x + b.w, c.x + c.w), bo = Math.min(b.y + b.h, c.y + c.h)
        if (r <= x || bo <= y) return null
        return { x, y, w: Math.round((r - x) * 100) / 100, h: Math.round((bo - y) * 100) / 100, b: bo }
      }
      let textBox = null
      if (status && status.textContent) { const rg = document.createRange(); rg.selectNodeContents(status); const r = rg.getBoundingClientRect(); textBox = { x: Math.round(r.x*100)/100, y: Math.round(r.y*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100, b: Math.round(r.bottom*100)/100 } }
      const statusBox = box(status)
      const scrollBox = box(document.querySelector('.log-scroll'))
      const inputBoxes = inputs.map(box).map((b) => clip(b, scrollBox)).filter(Boolean)
      const toast = document.querySelector('.toast')
      return {
        compact: document.querySelector('.app').className.includes('compact'),
        statusText: status ? status.textContent : null,
        statusBox, textBox,
        timer: box(document.querySelector('.rest-timer')),
        scroll: box(document.querySelector('.log-scroll')),
        tabbar: bar ? box(bar) : null,
        tabButton: btn ? box(btn) : null,
        activeTab: active ? box(active) : null,
        activeIndicator: active ? getComputedStyle(active, '::after').backgroundColor : null,
        tabbarPosition: bar ? getComputedStyle(bar).position : null,
        firstInput: inputBoxes[0] ?? null,
        inputCount: inputBoxes.length,
        visibleInputCount: inputBoxes.length,
        statusOverInputs: inputBoxes.filter((b) => overlaps(statusBox, b)).length,
        textOverInputs: inputBoxes.filter((b) => overlaps(textBox, b)).length,
        toastOverInputs: toast ? inputBoxes.filter((b) => overlaps(box(toast), b)).length : 0,
        tabbarOverInputs: inputBoxes.filter((b) => overlaps(box(bar), b)).length,
        tabbarOverStatus: overlaps(box(bar), statusBox),
        floatingToast: !!toast,
        hOverflow: document.documentElement.scrollWidth > innerWidth,
      }
    })()`

    await dt.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await dt.send('Page.navigate', { url: base })
    await waitFor('first paint', async () => await run(`!!document.querySelector('.app')`))
    await run(SEED(3))

    for (const [width, height] of VIEWPORTS) {
      const label = `${width}x${height}`
      console.log(`\n==== ${label} ====`)
      await dt.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
      await run(SEED(3))
      await dt.send('Page.navigate', { url: base })
      await waitFor('log view', async () => await run(`!!document.querySelector('.active-log .set-row .icon-btn')`))

      const idle = await run(MEASURE)
      record(`${label} compact mode as expected`, idle.compact === (height <= 420), `compact=${idle.compact} (height ${height}, threshold 420)`)
      record(`${label} tab bar in flow while logging`, idle.tabbarPosition === 'static', `position=${idle.tabbarPosition}`)
      console.log(`  note idle: tabbar ${JSON.stringify(idle.tabbar)} button h=${idle.tabButton?.h} indicator=${idle.activeIndicator}`)
      console.log(`  note idle: scroll ${JSON.stringify(idle.scroll)} firstInput ${JSON.stringify(idle.firstInput)} inputs=${idle.inputCount}`)

      // Start a rest, focus a field deep in the list the way a thumb would, then let it expire.
      await tap(`document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-row:not(.set-labels)')[0].querySelector('.icon-btn').click()`)
      await run(`(()=>{const f=document.querySelectorAll('.set-row:not(.set-labels) input')[8];f.focus();f.scrollIntoView({block:'center'})})()`)
      const resting = await run(MEASURE)
      await waitFor('rest completion line', async () => await run(`document.querySelector('.rest-status')?.textContent`), 8000)
      const done = await run(MEASURE)

      console.log(`  note done: status "${done.statusText}" box ${JSON.stringify(done.statusBox)} text ${JSON.stringify(done.textBox)}`)
      console.log(`  note done: tabbar ${JSON.stringify(done.tabbar)} scroll ${JSON.stringify(done.scroll)}`)

      // THE TOM-73 DEFECT CONDITION, stated as geometry.
      record(`${label} completion line never covers a set input`, done.statusOverInputs === 0 && done.textOverInputs === 0,
        `statusBox over ${done.statusOverInputs} input(s), rendered text over ${done.textOverInputs} of ${done.inputCount}`)
      record(`${label} completion is not a floating toast`, !done.floatingToast, `floating=${done.floatingToast}`)
      record(`${label} completion line stays above the scroller`, done.statusBox.b <= done.scroll.y + 0.5,
        `status bottom ${done.statusBox.b} vs scroller top ${done.scroll.y}`)
      record(`${label} completion text is inside its reserved row`, !!done.textBox && done.textBox.y >= done.statusBox.y - 0.5 && done.textBox.b <= done.statusBox.b + 0.5 && done.textBox.w <= done.statusBox.w,
        `text ${JSON.stringify(done.textBox)} in ${JSON.stringify(done.statusBox)}`)

      // THE TOM-69 SIDE OF THE INTERACTION: the indicator must not take vertical space from
      // anything, which at these heights would be taken straight out of the editor.
      record(`${label} tab bar never overlaps a set input`, done.tabbarOverInputs === 0, `${done.tabbarOverInputs} of ${done.inputCount}`)
      record(`${label} tab bar never overlaps the completion line`, !done.tabbarOverStatus, `${done.tabbarOverStatus}`)
      record(`${label} selected-tab indicator is painted`, done.activeIndicator === 'rgb(79, 195, 143)', `::after background ${done.activeIndicator}`)
      record(`${label} indicator costs the tab bar no height vs idle`, r2(done.tabbar.h) === r2(idle.tabbar.h), `${idle.tabbar.h} -> ${done.tabbar.h}`)

      // Geometry must not move across the three timer states — the TOM-39 invariant, re-checked
      // here because the tab bar is in flow and shares the column with the editor.
      // `firstInput` is deliberately left out here: this probe scrolls a deep field into view
      // between the idle and rest-done samples, so the first visible input is expected to
      // differ. The chrome boxes are the ones that must not move.
      const stable = ['tabbar', 'scroll', 'timer'].filter((k) => JSON.stringify(idle[k]) !== JSON.stringify(done[k]))
      record(`${label} chrome identical idle vs rest-done`, stable.length === 0, stable.length ? `moved: ${stable.join(', ')}` : 'tabbar/scroll/timer all unchanged')
      const stable2 = ['tabbar', 'scroll', 'timer', 'firstInput'].filter((k) => JSON.stringify(resting[k]) !== JSON.stringify(done[k]))
      record(`${label} layout identical resting vs rest-done`, stable2.length === 0, stable2.length ? `moved: ${stable2.join(', ')}` : 'tabbar/scroll/timer/firstInput all unchanged')
      record(`${label} no horizontal overflow`, !done.hOverflow, `scrollWidth>innerWidth=${done.hOverflow}`)
    }

    await dt.send('Target.closeTarget', { targetId }, null)
  } finally {
    chrome.kill(); server.close()
  }

  console.log('')
  if (failures.length) {
    console.error(`FAILED (${failures.length})`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log('All TOM-80 CSS-interaction checks passed.')
}

main().catch((err) => { console.error(err); process.exit(1) })
