#!/usr/bin/env node
// Regression probe for the TOM-61 finding against TOM-39: starting, extending, skipping or
// expiring the rest timer must not move the logging controls.
//
// The earlier candidate mounted the timer only while rest was running and grew a second row
// when its controls expanded, so the header, the first set and the input being typed into slid
// 59px down on start and 45px more on expand, then back up on Skip. This drives the real built
// app in headless Chromium and asserts the anchors hold the same y across every timer state.
//
// Measurement order matters. `idle-initial` is taken before any set is completed and
// `idle-after-skip` after one is; comparing those two first proves the set row's own `done`
// styling is not what moves the page, so a difference against the `running` states can only be
// the timer. All data is synthesized here; no real health data and no network.
//
//   npm run build && node tests/tom39-timer-stability.qa.mjs
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

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
}

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

function builtBasePath() {
  return readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/'
}

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
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    this.sessionId = undefined
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id == null) return
      const entry = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (!entry) return
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
      else entry.resolve(msg.result)
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

const VIEWPORTS = [
  { name: '360x800-portrait', width: 360, height: 800, mobile: true },
  { name: '390x844-portrait', width: 390, height: 844, mobile: true },
  { name: '844x390-landscape', width: 844, height: 390, mobile: true },
]

const LONG_NAME = 'Seated Incline Dumbbell Press (Neutral Grip, Paused at Bottom) — Machine #4'

const failures = []
function record(viewport, name, pass, detail) {
  if (!pass) failures.push(`[${viewport}] ${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom39-stability-chrome-'))
  const chrome = spawn(
    process.env.CHROME ?? 'chromium',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const devtoolsPort = await waitFor('chromium devtools', () => {
      if (!existsSync(portFile)) return null
      const [line] = readFileSync(portFile, 'utf8').split('\n')
      return line && /^\d+$/.test(line) ? line : null
    })
    const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    for (const vp of VIEWPORTS) {
      console.log(`\n=== ${vp.name} ===`)
      // Browser-level commands carry no session, and the previous viewport's session is gone.
      dt.sessionId = undefined
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await dt.send("Target.attachToTarget", { targetId, flatten: true })
      dt.sessionId = sessionId
      await dt.send('Page.enable')
      await dt.send('Runtime.enable')
      await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })
      await dt.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile,
      })

      const evaluate = async (expression) => {
        const { result, exceptionDetails } = await dt.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
        return result.value
      }

      await dt.send('Page.navigate', { url: base })
      await waitFor('first paint', async () => await evaluate(`!!document.querySelector('.app')`))
      await evaluate(`(() => {
        const now = Date.now()
        localStorage.setItem('wt.active.v1', JSON.stringify({
          active: {
            id: 'qa-active', date: new Date(now).toISOString().slice(0, 10), startedAt: now - 11 * 60_000,
            name: 'QA Synthetic Session',
            exercises: [
              { id: 'ex1', name: ${JSON.stringify(LONG_NAME)}, sets: [
                { weight: 135, reps: 8, done: false }, { weight: 135, reps: 8, done: false }, { weight: 135, reps: 8, done: false } ] },
              { id: 'ex2', name: 'Cable Row', sets: [ { weight: 90, reps: 10, done: false }, { weight: 90, reps: 10, done: false } ] },
            ],
          },
          templates: [],
          settings: { units: 'lbs', restSeconds: 90, philosophy: 'balanced' },
        }))
        localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
      })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('active log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))

      // The anchors a logger is actually looking at. Deliberately none of them is a set row
      // that the probe itself toggles, so only the timer can move them.
      const measure = () => evaluate(`(() => {
        const top = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null }
        const t = document.querySelector('.rest-timer')?.getBoundingClientRect()
        const s = document.querySelector('.log-scroll')?.getBoundingClientRect()
        const tb = document.querySelector('.tabbar')?.getBoundingClientRect()
        return {
          header: top('.log-header'),
          scroll: top('.log-scroll'),
          firstCard: top('.exercise-card'),
          firstInput: top('.exercise-card input'),
          timerPresent: !!t,
          timerHeight: t ? Math.round(t.height) : null,
          overlapsEditor: !!(t && s) && t.bottom > s.top + 1,
          overlapsTabbar: !!(t && tb) && t.bottom > tb.top + 1,
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          time: document.querySelector('.rest-time')?.textContent ?? null,
          actions: [...document.querySelectorAll('.rest-actions button')]
            .map((b) => b.textContent.trim() + (b.disabled ? ':disabled' : '')).join('|'),
        }
      })()`)

      const states = {}
      const completeSet = (card, row) =>
        evaluate(`document.querySelectorAll('.exercise-card')[${card}].querySelectorAll('.set-row:not(.set-labels)')[${row}].querySelector('.icon-btn').click()`)

      states['idle-initial'] = await measure()

      await completeSet(0, 0)
      await waitFor('rest running', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
      states['running'] = await measure()

      await evaluate(`[...document.querySelectorAll('.rest-actions button')].find(b => b.textContent.trim() === '+30s').click()`)
      await sleep(200)
      states['running-after-+30s'] = await measure()

      await evaluate(`[...document.querySelectorAll('.rest-actions button')].find(b => b.textContent.trim() === 'Skip').click()`)
      await waitFor('rest skipped', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—')
      states['idle-after-skip'] = await measure()

      await completeSet(0, 1)
      await waitFor('rest running again', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
      states['running-second-set'] = await measure()

      // Natural expiry, not another Skip. A 90s rest is too long to sit through, so drop
      // `restSeconds` to 3 in storage and reload: the reloaded page re-measures from the same
      // scroll position as `idle-initial`, so its anchors stay comparable with the rest.
      await evaluate(`(() => {
        const k = 'wt.active.v1', s = JSON.parse(localStorage.getItem(k))
        s.settings.restSeconds = 3
        delete s.active.restEndsAt
        delete s.active.restTotal
        localStorage.setItem(k, JSON.stringify(s))
      })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('active log reloaded', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))
      states['idle-reloaded'] = await measure()
      await completeSet(0, 2)
      await waitFor('short rest running', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
      states['running-short-rest'] = await measure()
      await waitFor('rest expires on its own',
        async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—', 10_000)
      states['idle-after-expiry'] = await measure()
      record(vp.name, 'expiry clears the deadline without unmounting the strip',
        await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt == null && !!document.querySelector('.rest-timer')`), '')

      const names = Object.keys(states)
      for (const anchor of ['header', 'scroll', 'firstCard', 'firstInput']) {
        const values = names.map((n) => `${n}=${states[n][anchor]}`)
        const distinct = new Set(names.map((n) => states[n][anchor]))
        record(vp.name, `${anchor} y never moves across ${names.length} timer states`,
          distinct.size === 1 && !distinct.has(null), values.join(' '))
      }

      record(vp.name, 'timer strip is present in every state', names.every((n) => states[n].timerPresent),
        names.filter((n) => !states[n].timerPresent).join(',') || 'all present')
      record(vp.name, 'timer height is constant', new Set(names.map((n) => states[n].timerHeight)).size === 1,
        `${states['idle-initial'].timerHeight}px`)
      record(vp.name, 'timer never overlaps the set editor', names.every((n) => !states[n].overlapsEditor), '')
      record(vp.name, 'timer never overlaps the tab bar', names.every((n) => !states[n].overlapsTabbar), '')
      record(vp.name, 'no horizontal overflow in any state', names.every((n) => !states[n].overflowX), '')
      record(vp.name, 'controls are live while resting and inert while idle',
        states['running'].actions === '+30s|Skip' && states['idle-initial'].actions === '+30s:disabled|Skip:disabled',
        `running "${states['running'].actions}" idle "${states['idle-initial'].actions}"`)
      record(vp.name, '+30s extends rather than restarts the countdown',
        (() => {
          const a = states['running'].time, b = states['running-after-+30s'].time
          const sec = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s }
          return sec(b) - sec(a) >= 29 && sec(b) - sec(a) <= 31
        })(), `${states['running'].time} -> ${states['running-after-+30s'].time}`)

      await dt.send("Target.closeTarget", { targetId }, null)
    }
  } finally {
    chrome.kill()
    server.close()
  }

  console.log('')
  if (failures.length) {
    console.error(`FAILED (${failures.length})`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log('All timer-stability checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
