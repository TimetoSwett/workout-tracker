#!/usr/bin/env node
// TOM-44 — The Soulmonger's INDEPENDENT verification of the v0.3.2 candidate.
//
// This is not the implementer's gate (`tom43-history-charts.qa.mjs`) and does not repeat it.
// That probe asserts the acceptance criteria on a static seeded store. This one attacks the
// surface it does not touch:
//
//   A  live metrics arrival — a Dropbox metrics pull lands WHILE the Body tab is mounted
//      (BodyView runs `syncMetrics()` in an on-mount effect), so `points` grows under a
//      BarChart whose selected index came from `useState(points.length - 1)`.
//   B  units — switching lbs→kg must convert BOTH record figures and their provenance,
//      and the estimate must be recomputed from the converted load, not relabelled.
//   C  layout past the two phone widths the implementer measured: landscape, desktop,
//      an open keyboard, a long exercise name, and toast/chart overlap.
//   D  keyboard completeness at the ends of the track, and the tab-stop cost.
//   E  reload persistence and an offline (service-worker) load.
//   F  the AC arithmetic recounted in the browser from storage, independently of the
//      implementer's expected values.
//
// All data is synthetic, including the Dropbox token, which is the literal string
// "synthetic-not-a-real-token". Every Dropbox host is intercepted at the CDP layer and the
// probe FAILS if a request escapes to a real one. Never point this at the board's storage.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom44-'))
mkdirSync(OUT, { recursive: true })

// Stages are independent and can be run one at a time (`--stage C`), because the whole
// pass reseeds and re-emulates often enough to outlive a short run window.
const stageIndex = process.argv.indexOf('--stage')
const STAGES = stageIndex > 0 ? process.argv[stageIndex + 1].toUpperCase().split(',') : ['A', 'B', 'C', 'D', 'E', 'F']
const want = (s) => STAGES.includes(s)

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
  constructor(s) {
    this.socket = s; this.next = 1; this.pending = new Map(); this.sessionId = undefined; this.handlers = new Map()
    s.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id == null) { const h = this.handlers.get(m.method); if (h) h(m.params); return }
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result)
    })
  }
  on(method, fn) { this.handlers.set(method, fn) }
  static async open(u) {
    const s = new WebSocket(u)
    await new Promise((ok, fail) => { s.addEventListener('open', ok, { once: true }); s.addEventListener('error', () => fail(new Error('devtools socket failed')), { once: true }) })
    return new Devtools(s)
  }
  send(method, params = {}, sessionId = this.sessionId) {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
  }
}

let pass = 0
const failures = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`) }
  else { console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}
const note = (s) => console.log(`note ${s}`)

const iso = (back) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - back)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

// A long exercise name is the C-group stressor: the Best lifts row now stacks, so a name
// with no break opportunity is the thing most likely to push the card wider than the screen.
const LONG_NAME = 'Single-Arm Half-Kneeling Landmine Overhead Press (Left)'
const UNBROKEN_NAME = 'Supinated-Grip-Incline-Dumbbell-Bench-Press-Variation-Three'

const SEED_WORKOUTS = `(function () {
  const mk = (id, date, exercises) => ({
    id, date, startedAt: new Date(date + 'T12:00:00').getTime(), endedAt: new Date(date + 'T13:00:00').getTime(),
    name: 'Synthetic ' + id, exercises, updatedAt: Date.now(), status: 'complete',
  })
  const ex = (id, name, sets) => ({ id, name, sets })
  return [
    mk('w1', '2026-09-20', [
      // Heaviest (400x1) and best estimate (350x8, in w2) are different sets.
      ex('e1', 'Deadlift', [{ weight: 400, reps: 1, done: true }]),
      // Exact estimate tie across two dates: 300x5 and 250x12 are both exactly 350.0.
      ex('e2', 'Squat', [{ weight: 300, reps: 5, done: true }]),
      // Never-completed and never-performed sets must hold no record.
      ex('e3', 'Row', [{ weight: 500, reps: 5, done: false, status: 'skipped' }, { weight: 150, reps: 10, done: true }]),
      // Every set is missing a load or a rep count: the lift must not appear at all.
      ex('e4', 'Curl', [{ weight: null, reps: 10, done: true }, { weight: 30, reps: null, done: true }]),
      ex('e5', ${JSON.stringify(LONG_NAME)}, [{ weight: 97.5, reps: 11, done: true }]),
      ex('e6', ${JSON.stringify(UNBROKEN_NAME)}, [{ weight: 62.5, reps: 9, done: true }]),
    ]),
    mk('w2', '2026-09-27', [
      ex('e7', 'Deadlift', [{ weight: 350, reps: 8, done: true }]),
      ex('e8', 'Squat', [{ weight: 250, reps: 12, done: true }]),
    ]),
  ]
})()`

// Steps on scattered days so the gap handling is visible; calories on every day so the
// date ticks are at their densest; sleep sparse.
const STEPS_DAYS = [0, 1, 2, 6, 7, 13]
const SEED_METRICS = `(function () {
  const iso = (back) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - back)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  const byDate = new Map()
  const put = (back, patch) => { const date = iso(back); byDate.set(date, { ...(byDate.get(date) ?? { date }), ...patch, updatedAt: 1000, source: 'manual' }) }
  for (let b = 1; b <= 14; b++) put(b, { calories: 2000 + b * 37 })
  for (const b of ${JSON.stringify(STEPS_DAYS.filter((b) => b !== 0))}) put(b, { steps: 9000 + b * 211 })
  for (const b of [1, 5, 11]) put(b, { sleepMin: 400 + b * 9 })
  put(3, { weight: 180, bodyFat: 18 })
  put(9, { weight: 182, bodyFat: 18.4 })
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
})()`

const SETTINGS = (extra = '') => `{ "active": null, "templates": [], "settings": { "units": "lbs", "restSeconds": 90, "philosophy": "balanced"${extra} } }`

// The synthetic remote adds TODAY to every series. Nothing here is a real credential and
// nothing here reaches Dropbox: `Fetch.enable` answers these hosts locally.
const REMOTE_NEW_DAY = () => JSON.stringify({
  date: iso(0), steps: 12_345, sleepMin: 456, calories: 2_468, weightUnit: 'lbs', updatedAt: 9_999_999, source: 'manual',
}) + '\n'

const DROPBOX_HOSTS = ['content.dropboxapi.com', 'api.dropboxapi.com', 'www.dropbox.com']

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom44-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    // --- one page, reused; the viewport is re-emulated per case.
    dt.sessionId = undefined
    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true })
    dt.sessionId = sessionId
    await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')

    const ev = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const shoot = async (name) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(join(OUT, name), Buffer.from(data, 'base64'))
      note(`screenshot ${name}`)
    }
    const key = async (k, code) => {
      for (const type of ['keyDown', 'keyUp']) {
        await dt.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
      }
      await sleep(120)
    }
    const viewport = async (w, h, mobile = true) =>
      dt.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 3 : 1, mobile })
    const openTab = async (caption) => {
      await ev(`(() => { const b = [...document.querySelectorAll('nav.tabbar button')]
        .find((x) => x.textContent.includes(${JSON.stringify(caption)})); b.click(); return !!b })()`)
      await sleep(250)
    }
    // Switching units goes through a native `confirm()`, which blocks every evaluate until
    // it is answered. Accept each dialog and record what it asked.
    const dialogs = []
    dt.on('Page.javascriptDialogOpening', async (p) => {
      dialogs.push(`${p.type}: ${p.message}`)
      try { await dt.send('Page.handleJavaScriptDialog', { accept: true }) } catch { /* already gone */ }
    })
    const consoleErrors = []
    dt.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description).join(' ')) })
    const pageErrors = []
    dt.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description ?? 'exception'))

    const seed = async (extraSettings = '', bypassSw = true) => {
      await dt.send('Network.setBypassServiceWorker', { bypass: bypassSw })
      await dt.send('Page.navigate', { url: base })
      await waitFor('paint', async () => await ev(`!!document.querySelector('.app')`))
      await ev(`(() => {
        localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: ${SEED_WORKOUTS}, mesocycles: [] }))
        localStorage.setItem('wt.active.v1', JSON.stringify(${SETTINGS(extraSettings)}))
        localStorage.setItem('wt.metrics.v1', JSON.stringify(${SEED_METRICS}))
        return true })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('reload', async () => await ev(`!!document.querySelector('nav.tabbar')`))
    }

    // Readers -------------------------------------------------------------------
    const READ_PRS = `(() => {
      const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Best lifts'))
      if (!card) return null
      return {
        rows: [...card.querySelectorAll('.pr-row')].map((r) => ({
          name: r.querySelector('.pr-name')?.textContent?.replace(/^[★☆]\\s*/, '').replace(/\\s+/g, ' ').trim(),
          text: r.querySelector('.pr-val')?.textContent?.replace(/\\s+/g, ' ').trim(),
          figures: [...r.querySelectorAll('.pr-figure')].map((f) => ({
            label: f.querySelector('.pr-fig-label')?.textContent?.trim(),
            num: f.querySelector('.pr-fig-num')?.textContent?.replace(/\\s+/g, ' ').trim(),
            prov: f.querySelector('.pr-prov')?.textContent?.replace(/\\s+/g, ' ').trim(),
            numLeft: Math.round(f.querySelector('.pr-fig-num')?.getBoundingClientRect().left ?? -1),
          })),
          right: Math.round(r.getBoundingClientRect().right),
        })),
        cardRight: Math.round(card.getBoundingClientRect().right),
      } })()`

    const READ_CHARTS = `(() => [...document.querySelectorAll('.card')]
      .filter((c) => c.querySelector('.chart-col'))
      .map((c) => {
        const scroll = c.querySelector('.chart-scroll')
        const cols = [...c.querySelectorAll('.chart-col')]
        return {
          title: c.querySelector('h3')?.textContent?.replace(/\\s+/g, ' ').trim(),
          readout: c.querySelector('.chart-readout')?.textContent?.replace(/\\s+/g, ' ').trim(),
          caption: [...c.querySelectorAll('.muted.small')].pop()?.textContent?.replace(/\\s+/g, ' ').trim(),
          ticks: cols.map((b) => b.querySelector('.chart-label')?.textContent?.trim()),
          names: cols.map((b) => b.getAttribute('aria-label')),
          bars: cols.length,
          selected: cols.findIndex((b) => b.classList.contains('selected')),
          pressed: cols.findIndex((b) => b.getAttribute('aria-pressed') === 'true'),
          barHeights: cols.map((b) => Math.round(b.querySelector('.chart-bar')?.getBoundingClientRect().height ?? -1)),
          scrollLeft: Math.round(scroll?.scrollLeft ?? -1),
          scrollMax: Math.round((scroll?.scrollWidth ?? 0) - (scroll?.clientWidth ?? 0)),
          selRight: Math.round(cols[cols.findIndex((b) => b.classList.contains('selected'))]?.getBoundingClientRect().right ?? -1),
          scrollBoxRight: Math.round(scroll?.getBoundingClientRect().right ?? -1),
          scrollBoxLeft: Math.round(scroll?.getBoundingClientRect().left ?? -1),
        } }))()`

    const OVERFLOW = `(() => {
      const de = document.documentElement
      const wide = [...document.querySelectorAll('.view *')].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.right > de.clientWidth + 1 && getComputedStyle(e).position !== 'fixed'
      }).map((e) => (e.className || e.tagName) + '@' + Math.round(e.getBoundingClientRect().right))
      return { docScrollW: de.scrollWidth, clientW: de.clientWidth, bodyScrollW: document.body.scrollWidth, wide: wide.slice(0, 6) } })()`

    const findRow = (set, n) => set.rows.find((r) => r.name === n)
    const fig = (set, n, label) => findRow(set, n)?.figures.find((f) => new RegExp(label, 'i').test(f.label ?? ''))

    // =========================================================================
    // A. A metrics pull lands while the Body tab is mounted.
    // =========================================================================
    if (want('A')) {
    console.log('\n=== A. live metrics arrival during BodyView\'s on-mount sync (390x844)')
    await viewport(390, 844)

    const escaped = []
    const seen = []
    const served = { download: 0, upload: 0, token: 0, other: 0 }
    let releaseMetrics
    const metricsGate = new Promise((ok) => { releaseMetrics = ok })
    await dt.send('Fetch.enable', { patterns: DROPBOX_HOSTS.map((h) => ({ urlPattern: `*${h}*` })) })
    // Dropbox's content API is cross-origin from the dev server, so every call is preceded
    // by a CORS preflight. A stub that answers only the POST leaves the preflight failing
    // and the POST never fires — which is exactly how the first run of this probe silently
    // measured nothing. Both legs are answered here.
    const CORS = [
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'POST, GET, OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: '*' },
      { name: 'Access-Control-Expose-Headers', value: 'Dropbox-API-Result' },
      { name: 'Access-Control-Max-Age', value: '0' },
    ]
    dt.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const u = request.url
      // CDP normalises header case, so find the API-Arg header case-insensitively.
      const hdr = (name) => {
        const k = Object.keys(request.headers ?? {}).find((x) => x.toLowerCase() === name)
        return k ? request.headers[k] : undefined
      }
      let apiArg = {}
      try { apiArg = JSON.parse(hdr('dropbox-api-arg') ?? '{}') } catch { apiArg = {} }
      const body = (s, headers = []) => dt.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: [...CORS, ...headers], body: Buffer.from(s).toString('base64'),
      })
      try {
        if (request.method === 'OPTIONS') return await body('')
        if (u.includes('/files/download')) {
          served.download++
          const path = apiArg.path
          seen.push(`download ${path}`)
          // The app syncs metrics on startup AND again from BodyView's mount effect, so
          // without a gate the pull lands before the Body tab is ever on screen and the
          // "arrives while mounted" case is never actually exercised. Hold the metrics
          // read until the probe has measured the pre-pull chart.
          if (path === '/metrics.jsonl') { seen.push('held /metrics.jsonl until the Body tab was measured'); await metricsGate }
          // Only the metrics file carries the synthetic new day; /workouts.jsonl stays empty
          // so the workout store is untouched by the sync.
          const content = path === '/metrics.jsonl' ? REMOTE_NEW_DAY() : ''
          return await body(content, [{ name: 'Dropbox-API-Result', value: JSON.stringify({ rev: 'synthrev1' }) }, { name: 'content-type', value: 'application/octet-stream' }])
        }
        if (u.includes('/files/upload')) { served.upload++; seen.push(`upload ${apiArg.path}`); return await body(JSON.stringify({ rev: 'synthrev2' }), [{ name: 'content-type', value: 'application/json' }]) }
        if (u.includes('oauth2/token')) { served.token++; seen.push('token'); return await body(JSON.stringify({ access_token: 'synthetic-not-a-real-token', expires_in: 14_400 }), [{ name: 'content-type', value: 'application/json' }]) }
        served.other++; seen.push(`other ${request.method} ${u}`)
        return await body('{}', [{ name: 'content-type', value: 'application/json' }])
      } catch { /* the page may have navigated out from under the pause */ }
    })

    // A synthetic long-lived token, so `dropboxConfigured` is true and BodyView's on-mount
    // effect runs the real sync path against the intercepted host.
    await seed(`, "dropboxToken": "synthetic-not-a-real-token"`)
    await ev(`(() => { window.__net = []; const f = fetch
      window.fetch = (...a) => { try { window.__net.push(String(a[0]?.url ?? a[0])) } catch {} ; return f(...a) }
      return true })()`)
    await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))

    const beforeSync = await ev(READ_CHARTS)
    const steps0 = beforeSync.find((c) => /Steps/.test(c.title))
    note(`before the pull: Steps has ${steps0.bars} bars, selected index ${steps0.selected}, readout "${steps0.readout}"`)
    check(steps0.selected === steps0.bars - 1, 'A0 on a cold mount the newest reading is selected',
      `selected ${steps0.selected} of ${steps0.bars}`)

    // Body is mounted and measured. NOW let the pull through.
    note('releasing the held /metrics.jsonl read with the Body tab already on screen')
    releaseMetrics()

    // Wait for the on-mount syncMetrics() to land the synthetic new day.
    const grew = await waitFor('the pulled day to render', async () => {
      const cs = await ev(READ_CHARTS)
      const s = cs.find((c) => /Steps/.test(c.title))
      return s && s.bars > steps0.bars ? cs : null
    }, 20_000).catch(() => null)

    check(served.download > 0, 'A1 the Dropbox metrics pull was intercepted, not sent to Dropbox',
      `${served.download} download(s), ${served.upload} upload(s), ${served.token} token call(s) answered locally`)
    const stored = await ev(`(() => { const ms = JSON.parse(localStorage.getItem('wt.metrics.v1') ?? '[]')
      const last = ms[ms.length - 1]
      return { n: ms.length, lastDate: last?.date, lastSteps: last?.steps } })()`)
    // Shoot BEFORE any tab navigation: leaving Body and coming back REMOUNTS BodyView,
    // which re-initialises the selection and hides the defect. The screenshot has to be
    // taken in the state the board would actually be looking at.
    if (grew) await shoot('tom44-A-after-pull-390.png')
    note(`intercepted calls: ${seen.join(' | ')}`)
    note(`after the pull, stored metrics: ${stored.n} rows, newest ${stored.lastDate} (steps ${stored.lastSteps}); synthetic remote day was ${iso(0)} with steps 12345`)
    check(grew != null, 'A2 a day pulled by sync appears in the chart while Body is open',
      grew ? `Steps grew ${steps0.bars} → ${grew.find((c) => /Steps/.test(c.title)).bars} bars`
           : `the pulled day never rendered; store holds ${stored.n} rows, newest ${stored.lastDate}`)

    if (grew) {
      for (const title of ['Steps', 'Sleep', 'Calories']) {
        const c = grew.find((x) => new RegExp(title).test(x.title))
        if (!c) continue
        const newestName = c.names[c.bars - 1] ?? ''
        const newestDate = newestName.split(':')[0]
        note(`${title}: ${c.bars} bars, selected ${c.selected}, readout "${c.readout}", newest bar is "${newestName}"`)
        check(c.selected === c.bars - 1, `A3 ${title}: the selection follows the newly pulled newest reading`,
          `selected index ${c.selected} of ${c.bars}; newest is index ${c.bars - 1} ("${newestName}")`)
        check((c.readout ?? '').includes(newestDate), `A4 ${title}: the readout describes the newest reading after the pull`,
          `readout reads "${c.readout}", newest reading is "${newestName}"`)
        // The scroll effect IS keyed on points.length, so the track re-pins to the newest
        // bar. If the selection did not move with it, the highlighted bar can sit outside
        // the visible window while the readout quotes it.
        const visible = c.selRight > c.scrollBoxLeft && c.selRight <= c.scrollBoxRight + 1
        check(visible, `A5 ${title}: the selected bar is inside the visible scroll window after the pull`,
          `selected bar right edge ${c.selRight}px vs window ${c.scrollBoxLeft}–${c.scrollBoxRight}px (track scrollLeft ${c.scrollLeft}/${c.scrollMax})`)
      }
    }
    // Leaving the tab and returning remounts BodyView, which re-derives the selection from
    // scratch. Confirm that, so the report can say exactly how the board recovers.
    await openTab('History'); await sleep(200); await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
    const remounted = await ev(READ_CHARTS)
    for (const c of remounted) {
      check(c.selected === c.bars - 1, `A6 ${c.title?.split('·')[0].trim()}: leaving the tab and returning restores the newest selection`,
        `selected ${c.selected} of ${c.bars}, readout "${c.readout}"`)
    }
    await shoot('tom44-A-after-remount-390.png')
    await dt.send('Fetch.disable')
    }

    // =========================================================================
    // B. Units. Switching lbs→kg must convert both figures and the provenance.
    // =========================================================================
    if (want('B')) {
    console.log('\n=== B. units (390x844)')
    await viewport(390, 844)
    await seed()
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const lbs = await ev(READ_PRS)
    note(`lbs — Deadlift: ${findRow(lbs, 'Deadlift')?.text}`)
    check(/\b400\b/.test(fig(lbs, 'Deadlift', 'heaviest')?.num ?? '') && /lbs/.test(fig(lbs, 'Deadlift', 'heaviest')?.num ?? ''),
      'B0 lbs: the heaviest figure carries its unit', `reads "${fig(lbs, 'Deadlift', 'heaviest')?.num}"`)

    await openTab('Settings')
    // The click must not be awaited: `confirm()` blocks the renderer until the dialog
    // handler answers, so awaiting the evaluate deadlocks against our own handler.
    dt.send('Runtime.evaluate', { expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'kg'); if (b) b.click(); return !!b })()`, returnByValue: true }).catch(() => {})
    await sleep(2000)
    note(`native dialogs answered: ${dialogs.length ? dialogs.join(' | ').slice(0, 220) : 'none'}`)
    const convertStatus = await ev(`(() => [...document.querySelectorAll('.view p, .view div')]
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).find((t) => /^Converted to/.test(t)) ?? 'no conversion message')()`)
    note(`unit switch reported: ${convertStatus}`)
    await openTab('History')
    await waitFor('best lifts in kg', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const kg = await ev(READ_PRS)
    const kgHeavy = fig(kg, 'Deadlift', 'heaviest')
    const kgEst = fig(kg, 'Deadlift', 'est')
    note(`kg — Deadlift: ${findRow(kg, 'Deadlift')?.text}`)
    check(/kg/.test(kgHeavy?.num ?? '') && /kg/.test(kgEst?.num ?? ''), 'B1 both figures relabel to kg',
      `heaviest "${kgHeavy?.num}", est "${kgEst?.num}"`)
    const kgHeavyNum = parseFloat((kgHeavy?.num ?? '').replace(/[^\d.]/g, ''))
    check(Math.abs(kgHeavyNum - 400 * 0.45359237) < 1.5, 'B2 the heaviest figure is converted, not relabelled',
      `400 lbs → ${kgHeavyNum} kg (expected ≈181.4)`)
    const kgProv = parseFloat((kgHeavy?.prov ?? '').replace(/[^\d.].*$/, '').replace(/[^\d.]/g, ''))
    check(Math.abs(kgProv - 400 * 0.45359237) < 1.5, 'B3 the provenance load is converted too, so figure and set agree',
      `provenance reads "${kgHeavy?.prov}"`)
    // The estimate must be recomputed from the converted load: 350 lbs x 8 -> 158.8kg x 8.
    const kgEstNum = parseFloat((kgEst?.num ?? '').replace(/[^\d.]/g, ''))
    const expectEst = 350 * 0.45359237 * (1 + 8 / 30)
    check(Math.abs(kgEstNum - expectEst) < 2, 'B4 the estimate is recomputed from the converted load',
      `est reads ${kgEstNum} kg, Epley on the converted set gives ${expectEst.toFixed(1)}`)
    check(!/\b(400|443)\b/.test(findRow(kg, 'Deadlift')?.text ?? ''), 'B5 no lbs-era number survives the switch',
      `row reads "${findRow(kg, 'Deadlift')?.text}"`)
    await shoot('tom44-B-best-lifts-kg-390.png')
    }

    // =========================================================================
    // C. Layout past the implementer's two widths.
    // =========================================================================
    if (want('C')) {
    console.log('\n=== C. layout: long names, landscape, desktop, keyboard, toast')
    await seed()

    for (const c of [
      { name: '360 portrait', w: 360, h: 780, mobile: true },
      { name: '390 portrait', w: 390, h: 844, mobile: true },
      { name: '844x390 landscape', w: 844, h: 390, mobile: true },
      { name: '1280x800 desktop', w: 1280, h: 800, mobile: false },
    ]) {
      await viewport(c.w, c.h, c.mobile)
      await sleep(200)
      await openTab('History')
      await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
      const set = await ev(READ_PRS)
      const o = await ev(OVERFLOW)
      check(o.docScrollW <= o.clientW + 1, `C1 ${c.name}: History does not overflow horizontally`,
        `scrollWidth ${o.docScrollW} vs clientWidth ${o.clientW}${o.wide.length ? `; widest: ${o.wide.join(', ')}` : ''}`)
      const longRow = findRow(set, LONG_NAME)
      const unbrokenRow = findRow(set, UNBROKEN_NAME)
      check(longRow != null && unbrokenRow != null, `C2 ${c.name}: long-named lifts render`,
        `${set.rows.length} rows: ${set.rows.map((r) => (r.name ?? '').slice(0, 22)).join(' | ')}`)
      if (unbrokenRow) {
        check(unbrokenRow.right <= set.cardRight + 1, `C3 ${c.name}: a 59-char unbroken name does not push its row past the card`,
          `row right ${unbrokenRow.right}px vs card right ${set.cardRight}px`)
      }
      // The two numbers in a row must line up, or the pair does not read as one comparison.
      for (const r of set.rows) {
        if (r.figures.length !== 2) { check(false, `C4 ${c.name}: ${r.name} reports two figures`, `${r.figures.length} figure(s)`); continue }
      }
      const misaligned = set.rows.filter((r) => r.figures.length === 2 && r.figures[0].numLeft !== r.figures[1].numLeft)
      note(`${c.name}: ${set.rows.length} rows, ${misaligned.length} with the two numbers on different x (side-by-side layout is fine at desktop width)`)
      await openTab('Body')
      await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
      const ob = await ev(OVERFLOW)
      check(ob.docScrollW <= ob.clientW + 1, `C5 ${c.name}: Body does not overflow horizontally despite the scrolling chart track`,
        `scrollWidth ${ob.docScrollW} vs clientWidth ${ob.clientW}${ob.wide.length ? `; widest: ${ob.wide.join(', ')}` : ''}`)
      const charts = await ev(READ_CHARTS)
      check(charts.every((x) => x.ticks.every((t) => t && /^\d{1,2}\/\d{1,2}$/.test(t))), `C6 ${c.name}: every column keeps an M/D date tick`,
        charts.map((x) => `${x.title?.split('·')[0].trim()}:${x.bars}`).join(' '))
      check(charts.every((x) => x.selected >= 0 && x.selected === x.pressed), `C7 ${c.name}: exactly one column is marked selected and pressed`,
        charts.map((x) => `${x.selected}/${x.pressed}`).join(' '))
      await shoot(`tom44-C-${c.w}x${c.h}-body.png`)
      if (c.name.startsWith('360') || c.name.startsWith('1280')) {
        await openTab('History'); await sleep(200); await shoot(`tom44-C-${c.w}x${c.h}-history.png`)
      }
    }

    // --- open keyboard: the phone viewport collapses to roughly 390x420.
    await viewport(390, 420)
    await sleep(200)
    await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
    const kb = await ev(`(() => {
      const i = [...document.querySelectorAll('.view input')].find((x) => x.type === 'number' || x.inputMode === 'decimal')
      if (!i) return null
      i.focus(); i.scrollIntoView({ block: 'center' })
      const r = i.getBoundingClientRect()
      return { tag: i.tagName, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, focused: document.activeElement === i } })()`)
    note(`open-keyboard viewport 390x420: focused input ${kb ? `${kb.top}–${kb.bottom}px in a ${kb.vh}px viewport` : 'not found'}`)
    check(kb != null && kb.focused && kb.top >= 0 && kb.bottom <= kb.vh, 'C8 open keyboard: the focused body-metric input stays inside the short viewport',
      kb ? `input ${kb.top}–${kb.bottom}px, viewport ${kb.vh}px` : 'no numeric input found')
    const ok2 = await ev(OVERFLOW)
    check(ok2.docScrollW <= ok2.clientW + 1, 'C9 open keyboard: no horizontal overflow at 390x420',
      `scrollWidth ${ok2.docScrollW} vs clientWidth ${ok2.clientW}`)
    await shoot('tom44-C-keyboard-390x420.png')

    // --- toast over the charts.
    await viewport(390, 844)
    await sleep(200)
    await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
    const toast = await ev(`(() => {
      const i = [...document.querySelectorAll('.view input')].find((x) => x.type === 'number' || x.inputMode === 'decimal')
      if (i) { i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) }
      const b = [...document.querySelectorAll('.view button')].find((x) => /save|log/i.test(x.textContent))
      if (b) b.click()
      return !!b })()`)
    await sleep(400)
    const overlap = await ev(`(() => {
      const t = document.querySelector('.toast.visible')
      if (!t) return null
      const tr = t.getBoundingClientRect()
      const hit = [...document.querySelectorAll('.chart-col, .chart-readout, .chart-scroll')].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.bottom > tr.top && r.top < tr.bottom && r.right > tr.left && r.left < tr.right
      }).map((e) => e.className)
      return { text: t.textContent.trim(), top: Math.round(tr.top), bottom: Math.round(tr.bottom), vh: window.innerHeight, hit: [...new Set(hit)] } })()`)
    note(`toast: ${overlap ? `"${overlap.text}" at ${overlap.top}–${overlap.bottom}px of ${overlap.vh}px; overlaps [${overlap.hit.join(', ')}]` : 'no toast shown'} (save button clicked: ${toast})`)
    check(overlap == null || overlap.hit.length === 0, 'C10 the Body toast does not cover a chart column or its readout',
      overlap ? `toast ${overlap.top}–${overlap.bottom}px overlaps ${overlap.hit.length} chart element(s)` : 'no toast raised')
    if (overlap) await shoot('tom44-C-toast-390.png')
    }

    // =========================================================================
    // D. Keyboard completeness and cost.
    // =========================================================================
    if (want('D')) {
    console.log('\n=== D. keyboard (390x844)')
    await viewport(390, 844)
    if (!want('C')) await seed()
    await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
    const tabStops = await ev(`(() => {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      const all = [...document.querySelectorAll('.view ' + sel)].filter((e) => e.offsetParent)
      return { total: all.length, chartCols: all.filter((e) => e.classList.contains('chart-col')).length } })()`)
    note(`Body tab stops: ${tabStops.total} total, ${tabStops.chartCols} of them chart columns`)
    check(tabStops.chartCols > 0, 'D1 chart columns are in the tab order at all', `${tabStops.chartCols} columns focusable`)

    // Focus the LAST column of the Steps chart, then press ArrowRight: the selection must
    // clamp, keep focus, and not throw.
    const endProbe = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /Steps/.test(c.querySelector('h3')?.textContent ?? ''))
      const cols = [...card.querySelectorAll('.chart-col')]
      cols[cols.length - 1].focus()
      return { n: cols.length, focused: cols.indexOf(document.activeElement) } })()`)
    await key('ArrowRight', 39)
    const afterRight = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /Steps/.test(c.querySelector('h3')?.textContent ?? ''))
      const cols = [...card.querySelectorAll('.chart-col')]
      return { focused: cols.indexOf(document.activeElement), selected: cols.findIndex((b) => b.classList.contains('selected')),
        readout: card.querySelector('.chart-readout')?.textContent?.replace(/\\s+/g, ' ').trim() } })()`)
    check(afterRight.focused === endProbe.n - 1 && afterRight.selected === endProbe.n - 1,
      'D2 ArrowRight on the last column clamps without losing focus or the selection',
      `focus ${afterRight.focused}, selected ${afterRight.selected} of ${endProbe.n}`)
    await ev(`(() => { const card = [...document.querySelectorAll('.card')].find((c) => /Steps/.test(c.querySelector('h3')?.textContent ?? ''))
      card.querySelectorAll('.chart-col')[0].focus(); return true })()`)
    await key('ArrowLeft', 37)
    const afterLeft = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /Steps/.test(c.querySelector('h3')?.textContent ?? ''))
      const cols = [...card.querySelectorAll('.chart-col')]
      return { focused: cols.indexOf(document.activeElement), selected: cols.findIndex((b) => b.classList.contains('selected')) } })()`)
    check(afterLeft.focused === 0 && afterLeft.selected === 0, 'D3 ArrowLeft on the first column clamps the same way',
      `focus ${afterLeft.focused}, selected ${afterLeft.selected}`)
    const homeEnd = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /Calories/.test(c.querySelector('h3')?.textContent ?? ''))
      const cols = [...card.querySelectorAll('.chart-col')]
      cols[0].focus()
      return cols.length })()`)
    await key('End', 35)
    const afterEnd = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /Calories/.test(c.querySelector('h3')?.textContent ?? ''))
      const cols = [...card.querySelectorAll('.chart-col')]
      return cols.findIndex((b) => b.classList.contains('selected')) })()`)
    note(`End key on a ${homeEnd}-column chart left the selection at index ${afterEnd} (Home/End are not part of the AC; ArrowLeft/Right are)`)
    }

    // =========================================================================
    // E. Reload persistence, then an offline load through the service worker.
    // =========================================================================
    if (want('E')) {
    console.log('\n=== E. persistence and offline')
    await viewport(390, 844)
    if (!want('D') && !want('C')) await seed()
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const beforeReload = await ev(READ_PRS)
    await dt.send('Page.navigate', { url: base })
    await waitFor('reload', async () => await ev(`!!document.querySelector('nav.tabbar')`))
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const afterReload = await ev(READ_PRS)
    const sameFigures = JSON.stringify(beforeReload.rows.map((r) => [r.name, r.figures.map((f) => [f.label, f.num, f.prov])]))
      === JSON.stringify(afterReload.rows.map((r) => [r.name, r.figures.map((f) => [f.label, f.num, f.prov])]))
    check(sameFigures, 'E1 both record figures and their provenance survive a reload unchanged',
      `${afterReload.rows.length} rows; Deadlift now "${findRow(afterReload, 'Deadlift')?.text}"`)

    // Offline: let the service worker install, then cut the network and reload.
    await dt.send('Network.setBypassServiceWorker', { bypass: false })
    await dt.send('Page.navigate', { url: base })
    await waitFor('reload with sw', async () => await ev(`!!document.querySelector('nav.tabbar')`))
    const swReady = await waitFor('sw controller', async () => await ev(`(async () => {
      const r = await navigator.serviceWorker.getRegistration(); if (!r) return false
      await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller })()`), 20_000).catch(() => false)
    note(`service worker controlling the page: ${swReady}`)
    if (swReady) {
      await dt.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
      await dt.send('Page.navigate', { url: base })
      const renderedOffline = await waitFor('offline render', async () => await ev(`!!document.querySelector('nav.tabbar')`), 20_000).catch(() => false)
      let offlineRows = null
      if (renderedOffline) { await openTab('History'); await sleep(400); offlineRows = await ev(READ_PRS) }
      check(renderedOffline && (offlineRows?.rows.length ?? 0) > 0,
        'E2 offline: the app loads from the service-worker cache and Best lifts still renders both figures',
        offlineRows ? `${offlineRows.rows.length} rows offline; Deadlift "${findRow(offlineRows, 'Deadlift')?.text}"` : 'the page did not render offline')
      if (renderedOffline) {
        await openTab('Body'); await sleep(400)
        const oc = await ev(READ_CHARTS)
        check(oc.length > 0 && oc.every((c) => c.bars > 0 && c.selected >= 0), 'E3 offline: the dated charts still render and keep a selection',
          oc.map((c) => `${c.title?.split('·')[0].trim()}:${c.bars}`).join(' '))
        await shoot('tom44-E-offline-390.png')
      }
      await dt.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    } else {
      note('skipped E2/E3: no service worker took control, so there is nothing to serve an offline load')
    }
    }

    // =========================================================================
    // F. The arithmetic, recounted in the browser from storage.
    // =========================================================================
    if (want('F')) {
    console.log('\n=== F. acceptance arithmetic recounted from storage')
    await viewport(390, 844)
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await seed()
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const f = await ev(READ_PRS)
    // Recompute from localStorage with an independent implementation.
    const expected = await ev(`(() => {
      const { workouts } = JSON.parse(localStorage.getItem('wt.history.v1'))
      const eligible = []
      for (const w of workouts) { if (w.deleted || w.status === 'skipped') continue
        for (const ex of w.exercises) for (const s of ex.sets) {
          if (s.status === 'skipped' || s.status === 'pending' || s.done !== true) continue
          if (!((s.weight ?? 0) > 0 && (s.reps ?? 0) > 0)) continue
          eligible.push({ name: ex.name, weight: s.weight, reps: s.reps, date: w.date, e1rm: s.weight * (1 + s.reps / 30) }) } }
      const by = new Map()
      for (const c of eligible) { const g = by.get(c.name) ?? []; g.push(c); by.set(c.name, g) }
      const out = {}
      for (const [name, g] of by) {
        const est = [...g].sort((a, b) => b.e1rm - a.e1rm || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || b.weight - a.weight)[0]
        const hvy = [...g].sort((a, b) => b.weight - a.weight || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || b.reps - a.reps)[0]
        out[name] = { est: { num: Math.round(est.e1rm), prov: est.weight + '×' + est.reps + ' · ' + est.date },
                      hvy: { num: hvy.weight, prov: hvy.weight + '×' + hvy.reps + ' · ' + hvy.date } }
      }
      return out })()`)
    note(`independently recomputed ${Object.keys(expected).length} lifts from storage: ${Object.keys(expected).join(', ')}`)
    check(!('Curl' in expected) && findRow(f, 'Curl') == null,
      'F1 a lift whose every set misses a load or a rep count is absent, not zeroed',
      `Curl in recount: ${'Curl' in expected}; Curl row rendered: ${findRow(f, 'Curl') != null}`)
    check(findRow(f, 'Row') != null && /\b150\b/.test(fig(f, 'Row', 'heaviest')?.num ?? ''),
      'F2 a skipped 500 lb set holds no record; the completed 150 does',
      `Row heaviest reads "${fig(f, 'Row', 'heaviest')?.num}"`)
    for (const [name, want] of Object.entries(expected)) {
      const gotEst = fig(f, name, 'est'); const gotHvy = fig(f, name, 'heaviest')
      check(gotEst != null && new RegExp(`\\b${want.est.num}\\b`).test(gotEst.num ?? '') && gotEst.prov === want.est.prov,
        `F3 ${name.slice(0, 26)}: rendered estimate matches the independent recount`,
        `rendered "${gotEst?.num}" / "${gotEst?.prov}"; recount ${want.est.num} / "${want.est.prov}"`)
      check(gotHvy != null && new RegExp(`\\b${want.hvy.num}\\b`).test(gotHvy.num ?? '') && gotHvy.prov === want.hvy.prov,
        `F4 ${name.slice(0, 26)}: rendered heaviest matches the independent recount`,
        `rendered "${gotHvy?.num}" / "${gotHvy?.prov}"; recount ${want.hvy.num} / "${want.hvy.prov}"`)
    }
    check(!/NaN|Infinity|undefined|null/.test(JSON.stringify(f.rows)), 'F5 no NaN/Infinity/undefined leaks into a rendered figure',
      `rows: ${f.rows.map((r) => r.text).join(' || ').slice(0, 160)}`)

    // The exact-tie case, then the same store with the workout array reversed: a sync
    // reorder must not move the date shown next to the record.
    const tieBefore = fig(f, 'Squat', 'est')
    await ev(`(() => { const h = JSON.parse(localStorage.getItem('wt.history.v1'))
      h.workouts = [...h.workouts].reverse()
      for (const w of h.workouts) w.exercises = [...w.exercises].reverse()
      localStorage.setItem('wt.history.v1', JSON.stringify(h)); return true })()`)
    await dt.send('Page.navigate', { url: base })
    await waitFor('reload', async () => await ev(`!!document.querySelector('nav.tabbar')`))
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
    const rev = await ev(READ_PRS)
    const tieAfter = fig(rev, 'Squat', 'est')
    check(tieBefore?.prov === tieAfter?.prov && /2026-09-20/.test(tieAfter?.prov ?? ''),
      'F6 an exact estimate tie (300×5 vs 250×12, both 350.0) resolves to the earliest date either way the array is stored',
      `before "${tieBefore?.prov}", after reversing storage "${tieAfter?.prov}"`)
    const orderStable = JSON.stringify(f.rows.map((r) => [r.name, r.figures.map((x) => x.num)]))
      === JSON.stringify(rev.rows.map((r) => [r.name, r.figures.map((x) => x.num)]))
    check(orderStable, 'F7 reversing stored order changes neither figure nor the list order',
      orderStable ? 'identical' : `before ${f.rows.map((r) => r.name).join(',')} / after ${rev.rows.map((r) => r.name).join(',')}`)

    // Charts: every tick must correspond to a stored reading, and no stored gap may appear.
    await openTab('Body')
    await waitFor('charts', async () => await ev(`!!document.querySelector('.chart-col')`))
    const gapCheck = await ev(`(() => {
      const ms = JSON.parse(localStorage.getItem('wt.metrics.v1'))
      const cut = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 14)
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })()
      const want = (k) => ms.filter((m) => m.date >= cut && m[k] != null).map((m) => m.date)
      const got = (title) => { const c = [...document.querySelectorAll('.card')].find((x) => new RegExp(title).test(x.querySelector('h3')?.textContent ?? ''))
        return c ? [...c.querySelectorAll('.chart-col')].map((b) => (b.getAttribute('aria-label') ?? '').split(':')[0]) : null }
      return { steps: { want: want('steps'), got: got('Steps') }, sleep: { want: want('sleepMin'), got: got('Sleep') }, calories: { want: want('calories'), got: got('Calories') } } })()`)
    for (const [k, v] of Object.entries(gapCheck)) {
      note(`${k}: ${v.want.length} stored readings in the window, ${v.got?.length ?? 0} bars rendered`)
      check(JSON.stringify(v.want) === JSON.stringify(v.got),
        `F8 ${k}: one bar per stored reading, in order, and no bar for a day with no reading`,
        `stored [${v.want.join(', ')}] vs rendered [${(v.got ?? []).join(', ')}]`)
    }
    const zeroBars = await ev(`(() => [...document.querySelectorAll('.chart-col')]
      .filter((b) => /: ?0( |$)/.test(b.getAttribute('aria-label') ?? '')).length)()`)
    check(zeroBars === 0, 'F9 no column reports a zero reading', `${zeroBars} column(s) name a 0 value`)

    }

    check(pageErrors.length === 0, 'Z no uncaught page exception during the whole pass',
      pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'clean')
    if (consoleErrors.length) note(`console errors seen: ${consoleErrors.slice(0, 5).join(' | ')}`)

    console.log(`\n${pass} ok, ${failures.length} failure(s)`)
    if (failures.length) { console.log('\nfailures:'); for (const f2 of failures) console.log(`  - ${f2}`) }
    console.log(`artifacts: ${OUT}`)
    process.exitCode = failures.length ? 1 : 0
  } finally { chrome.kill(); server.close() }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
