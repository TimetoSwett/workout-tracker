#!/usr/bin/env node
// TOM-43 regression gate for the v0.3.2 batch ("useful history and charts").
//
// The companion probe `tom44-chart-baseline.qa.mjs` measured what shipped code did *before*
// this batch and always exits 0, because a baseline is a record, not a gate. This file is
// the gate: it asserts the v0.3.2 acceptance criteria and exits non-zero when one breaks.
//
// What it checks, criterion by criterion:
//   AC1  max lifted weight and max estimated 1RM are reduced independently, and a lift
//        whose two records come from different sets reports both sets.
//   AC2  the modelled figure is labelled "est" at the number, not only in the card blurb.
//   AC3  only record-eligible completed sets score (done:false, status skipped/pending,
//        and sets missing a weight or a rep count are all excluded) — and an empty
//        history renders no Best lifts card rather than crashing.
//   AC4  an exact estimated-1RM tie resolves to the same set however storage is ordered.
//   AC5  every chart column carries a date tick with room to render, an accessible name,
//        and keyboard focus; the selected reading is written out in text and moves with a
//        tap and with an arrow key; a day with no reading is omitted, never drawn as zero.
//   plus no horizontal page overflow at either phone width.
//
// All data is synthetic. Never point this at the board's real storage.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom43-'))
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

let pass = 0
const failures = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`) }
  else { console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures.push(`${label}${detail ? ` — ${detail}` : ''}`) }
}
const note = (s) => console.log(`note ${s}`)

// 360px is the narrowest width the shared QA gate names; 390px is the board's phone.
const CASES = [
  { name: '360', width: 360, height: 780 },
  { name: '390', width: 390, height: 844 },
]

// Synthetic history. Each exercise isolates exactly one acceptance criterion.
//   Deadlift      — max weight (400x1, 09-20) and max est 1RM (350x8, 09-27) are DIFFERENT sets.
//   Press         — the heaviest set by est 1RM was never completed (done:false).
//   Row           — a 500lb set marked `skipped` must never win.
//   Pulldown      — a 300lb set marked `pending` (RP-imported but never done) must never win.
//   Squat         — 300x5 and 250x12 are an EXACT est 1RM tie (both 350.0) on different dates.
//   Curl          — every set is missing a weight or a rep count; the lift must not appear.
const SEED_WORKOUTS = `(function () {
  const mk = (id, date, exercises) => ({
    id, date, startedAt: new Date(date + 'T12:00:00').getTime(),
    endedAt: new Date(date + 'T13:00:00').getTime(),
    name: 'Synthetic ' + id, exercises, updatedAt: Date.now(), status: 'complete',
  })
  const ex = (id, name, sets) => ({ id, name, sets })
  return [
    mk('w1', '2026-09-20', [
      ex('e1', 'Deadlift', [{ weight: 400, reps: 1, done: true }]),
      ex('e2', 'Press', [{ weight: 100, reps: 5, done: true }]),
      ex('e3', 'Row', [{ weight: 500, reps: 5, done: false, status: 'skipped' }, { weight: 150, reps: 10, done: true }]),
      ex('e4', 'Squat', [{ weight: 300, reps: 5, done: true }]),
      ex('e5', 'Curl', [{ weight: null, reps: 10, done: true }, { weight: 30, reps: null, done: true }]),
      ex('e9', 'Pulldown', [{ weight: 120, reps: 10, done: true, status: 'complete' }, { weight: 300, reps: 5, done: false, status: 'pending' }]),
    ]),
    mk('w2', '2026-09-27', [
      ex('e6', 'Deadlift', [{ weight: 350, reps: 8, done: true }]),
      ex('e7', 'Press', [{ weight: 135, reps: 5, done: false }]),
      ex('e8', 'Squat', [{ weight: 250, reps: 12, done: true }]),
    ]),
  ]
})()`

// Calories on every day in the window (worst case for date-tick density);
// steps on six scattered days (so the gap handling is visible); sleep on three.
const SEED_METRICS = `(function () {
  const iso = (back) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - back);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  const byDate = new Map()
  const put = (back, patch) => { const date = iso(back); byDate.set(date, { ...(byDate.get(date) ?? { date }), ...patch, updatedAt: Date.now(), source: 'manual' }) }
  for (let b = 0; b <= 14; b++) put(b, { calories: 2000 + b * 37 })
  for (const b of [0, 1, 2, 6, 7, 13]) put(b, { steps: 9000 + b * 211 })
  for (const b of [0, 5, 11]) put(b, { sleepMin: 400 + b * 9 })
  put(3, { weight: 180, bodyFat: 18 })
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
})()`

const SETTINGS = `{ "active": null, "templates": [], "settings": { "units": "lbs", "restSeconds": 90, "philosophy": "balanced" } }`

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom43-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    for (const c of CASES) {
      console.log(`\n=== ${c.width}x${c.height} (DPR 3)`)
      // Clear the previous case's session first: `send` defaults its third argument to
      // `this.sessionId`, so passing an explicit `undefined` still picks up the stale id.
      dt.sessionId = undefined
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true })
      dt.sessionId = sessionId
      await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })
      await dt.send('Emulation.setDeviceMetricsOverride', { width: c.width, height: c.height, deviceScaleFactor: 3, mobile: true })
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
      const openTab = async (caption) => {
        await ev(`(() => { const b = [...document.querySelectorAll('nav.tabbar button')]
          .find((x) => x.textContent.includes(${JSON.stringify(caption)})); b.click(); return !!b })()`)
        await sleep(250)
      }
      const seed = async (workouts, metrics) => {
        await dt.send('Page.navigate', { url: base })
        await waitFor('paint', async () => await ev(`!!document.querySelector('.app')`))
        // Both stores read localStorage at module init, so seed then reload.
        await ev(`(() => {
          localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: ${workouts}, mesocycles: [] }))
          localStorage.setItem('wt.active.v1', JSON.stringify(${SETTINGS}))
          localStorage.setItem('wt.metrics.v1', JSON.stringify(${metrics}))
          return true })()`)
        await dt.send('Page.navigate', { url: base })
        await waitFor('reload', async () => await ev(`!!document.querySelector('nav.tabbar')`))
      }

      await seed(SEED_WORKOUTS, SEED_METRICS)

      // ---------------------------------------------------------------- Best lifts
      await openTab('History')
      await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
      const readRows = `(() => {
        const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Best lifts'))
        if (!card) return null
        return {
          blurb: card.querySelector('p')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
          rows: [...card.querySelectorAll('.pr-row')].map((r) => ({
            name: r.querySelector('.pr-name')?.textContent?.replace(/^[★☆]\\s*/, '').replace(/\\s+/g, ' ').trim(),
            value: r.querySelector('.pr-val')?.textContent?.replace(/\\s+/g, ' ').trim(),
            figures: [...r.querySelectorAll('.pr-figure')].map((f) => ({
              label: f.querySelector('.pr-fig-label')?.textContent?.trim(),
              num: f.querySelector('.pr-fig-num')?.textContent?.replace(/\\s+/g, ' ').trim(),
              prov: f.querySelector('.pr-prov')?.textContent?.replace(/\\s+/g, ' ').trim(),
              // A figure that wraps inside itself is unreadable; the pair may wrap, one may not.
              lines: Math.round(f.getBoundingClientRect().height / parseFloat(getComputedStyle(f).lineHeight || '20')),
              width: f.getBoundingClientRect().width,
              // The two numbers in a row must start at the same x, or the pair reads as
              // two unrelated lines rather than one comparison.
              numLeft: Math.round(f.querySelector('.pr-fig-num')?.getBoundingClientRect().left ?? -1),
            })),
            rowH: r.getBoundingClientRect().height,
          })),
          cardW: card.getBoundingClientRect().width,
        } })()`
      const prs = await ev(readRows)
      const row = (n) => prs.rows.find((r) => r.name === n)
      const figure = (n, label) => row(n)?.figures.find((f) => new RegExp(label, 'i').test(f.label ?? ''))

      // --- AC1: two independent reductions, from two different sets.
      const deadlift = row('Deadlift')
      note(`Deadlift row reads: ${deadlift?.value}`)
      const dlEst = figure('Deadlift', 'est')
      const dlMax = figure('Deadlift', 'heaviest')
      check(deadlift?.figures.length === 2, 'AC1 each lift reports two figures',
        `Deadlift shows ${deadlift?.figures.length} figure(s)`)
      check(/\b400\b/.test(dlMax?.num ?? ''), 'AC1 heaviest weight ever lifted (400) is reported',
        `seeded 400x1 (heaviest) and 350x8 (best est 1RM); heaviest figure reads "${dlMax?.num}"`)
      check(/\b443\b/.test(dlEst?.num ?? ''), 'AC1 best estimated 1RM (443) is reported',
        `est figure reads "${dlEst?.num}"`)
      check(/400×1/.test(dlMax?.prov ?? '') && /2026-09-20/.test(dlMax?.prov ?? ''),
        'AC1 the heaviest figure cites its own set, not the 1RM winner\'s',
        `heaviest provenance reads "${dlMax?.prov}" (expected 400×1 · 2026-09-20)`)
      check(/350×8/.test(dlEst?.prov ?? '') && /2026-09-27/.test(dlEst?.prov ?? ''),
        'AC1 the est 1RM figure cites its own set', `est provenance reads "${dlEst?.prov}"`)
      // Units are on the number, not implied by the card.
      check(/lbs/.test(dlEst?.num ?? '') && /lbs/.test(dlMax?.num ?? ''), 'AC1 both figures carry units',
        `est "${dlEst?.num}", heaviest "${dlMax?.num}"`)

      // --- AC2: the modelled figure says it is modelled, at the number.
      // `\best\b` rather than a bare /est/: "heaviest" contains "est" and would match.
      const ESTIMATED = /\best\b|estimat/i
      check(ESTIMATED.test(dlEst?.label ?? ''), 'AC2 the modelled figure is labelled estimated at the number',
        `label reads "${dlEst?.label}" beside "${dlEst?.num}"`)
      check(!ESTIMATED.test(dlMax?.label ?? ''), 'AC2 the measured figure is not labelled estimated',
        `label reads "${dlMax?.label}"`)

      // --- AC3: eligibility is the one `records` rule, for BOTH figures.
      note(`Press row reads: ${row('Press')?.value}`)
      check(!/135/.test(row('Press')?.value ?? ''), 'AC3 an un-completed set (done:false) scores neither figure',
        `seeded Press 100x5 done:true and 135x5 done:false; row shows "${row('Press')?.value}"`)
      check(!/500/.test(row('Row')?.value ?? ''), 'AC3 a set marked status:"skipped" scores neither figure',
        `Row shows "${row('Row')?.value}"`)
      check(!/300/.test(row('Pulldown')?.value ?? ''), 'AC3 a set marked status:"pending" scores neither figure',
        `seeded Pulldown 120x10 complete and 300x5 pending; row shows "${row('Pulldown')?.value}"`)
      check(!row('Curl'), 'AC3 a lift whose every set lacks a weight or reps does not appear',
        row('Curl') ? `Curl shows "${row('Curl').value}"` : 'Curl absent, correct')

      // --- Layout: a figure must not wrap inside itself, and the row must stay bounded.
      const splitFigures = prs.rows.flatMap((r) => r.figures.filter((f) => f.lines > 1).map((f) => `${r.name}/${f.label}`))
      note(`Best lifts card is ${prs.cardW.toFixed(1)}px; widest figure measures ` +
        `${Math.max(...prs.rows.flatMap((r) => r.figures.map((f) => f.width))).toFixed(1)}px`)
      check(splitFigures.length === 0, 'AC-layout no record figure wraps inside itself',
        splitFigures.length ? `wrapped: ${splitFigures.join(', ')}` : 'every figure renders on one line')
      // Both figures stack, so their numbers have to share a left edge to read as a pair.
      const misaligned = prs.rows.filter((r) => new Set(r.figures.map((f) => f.numLeft)).size > 1)
      check(misaligned.length === 0, 'AC-layout the two figures in a row line their numbers up',
        misaligned.length
          ? misaligned.map((r) => `${r.name} at ${r.figures.map((f) => f.numLeft).join('/')}px`).join(', ')
          : `every row aligns at x=${prs.rows[0].figures[0].numLeft}px`)
      const tallRows = prs.rows.filter((r) => r.rowH > 90)
      check(tallRows.length === 0, 'AC-layout a Best lifts row stays within three lines',
        tallRows.length ? `${tallRows.map((r) => `${r.name} ${r.rowH.toFixed(0)}px`).join(', ')}` : `tallest row is ${Math.max(...prs.rows.map((r) => r.rowH)).toFixed(0)}px`)

      await shoot(`tom43-best-lifts-${c.name}.png`)

      // --- AC4: ties resolve identically whatever order storage hands over.
      const squat = row('Squat')
      note(`Squat row reads: ${squat?.value} (300x5 on 09-20 and 250x12 on 09-27 both compute 350.0)`)
      await ev(`(() => {
        const slice = JSON.parse(localStorage.getItem('wt.history.v1'))
        slice.workouts = [...slice.workouts].reverse()
        localStorage.setItem('wt.history.v1', JSON.stringify(slice))
        return true })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('reload', async () => await ev(`!!document.querySelector('nav.tabbar')`))
      await openTab('History')
      await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row.stacked')`))
      const reversed = await ev(readRows)
      const squatAfter = reversed.rows.find((r) => r.name === 'Squat')
      note(`Squat row after reversing stored workout order: ${squatAfter?.value}`)
      check(squat?.value === squatAfter?.value, 'AC4 an exact est 1RM tie resolves to the same set regardless of storage order',
        `"${squat?.value}" before vs "${squatAfter?.value}" after reversing the stored array`)
      check(/2026-09-20/.test(figure('Deadlift', 'heaviest')?.prov ?? '') ||
        /2026-09-20/.test(reversed.rows.find((r) => r.name === 'Deadlift')?.figures.find((f) => /heaviest/i.test(f.label))?.prov ?? ''),
        'AC4 the heaviest-weight figure is order-independent too',
        `heaviest provenance after reversal: "${reversed.rows.find((r) => r.name === 'Deadlift')?.figures.find((f) => /heaviest/i.test(f.label))?.prov}"`)

      // ---------------------------------------------------------------- Charts
      await openTab('Body')
      await waitFor('charts', async () => await ev(`!!document.querySelector('.chart')`))
      const readCharts = `(() => {
        // Measure .chart-label's real font off a real element, so the tick width is the
        // browser's number rather than arithmetic on paper.
        const probe = document.createElement('span')
        probe.className = 'chart-label'
        document.body.appendChild(probe)
        const cs = getComputedStyle(probe)
        const fontSize = cs.fontSize
        const font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + fontSize + '/' + cs.lineHeight + ' ' + cs.fontFamily
        const ctx = document.createElement('canvas').getContext('2d')
        ctx.font = font
        probe.remove()
        const widest = Math.max(...['9/9', '10/9', '12/28'].map((s) => ctx.measureText(s).width))
        return {
          font, fontSize, widestTick: widest,
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          charts: [...document.querySelectorAll('.card')].filter((card) => card.querySelector('.chart')).map((card) => {
            const cols = [...card.querySelectorAll('.chart-col')]
            const rects = cols.map((x) => x.getBoundingClientRect())
            return {
              title: card.querySelector('h3')?.textContent?.replace(/\\s+/g, ' ').trim(),
              caption: card.querySelector('.muted.small')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
              readout: card.querySelector('.chart-readout')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
              bars: cols.length,
              colWidth: rects.length ? Math.min(...rects.map((r) => r.width)) : 0,
              chartWidth: card.querySelector('.chart').getBoundingClientRect().width,
              labels: cols.filter((x) => x.querySelector('.chart-label')?.textContent?.trim()).length,
              ticks: cols.map((x) => x.querySelector('.chart-label')?.textContent?.trim()),
              focusable: cols.filter((x) => x.tabIndex >= 0).length,
              named: cols.filter((x) => (x.getAttribute('aria-label') ?? '').trim()).length,
              buttons: cols.filter((x) => x.tagName === 'BUTTON').length,
              selected: cols.filter((x) => x.classList.contains('selected')).length,
              lastLabel: cols.length ? cols[cols.length - 1].getAttribute('aria-label') : null,
            }
          }),
        } })()`
      const charts = await ev(readCharts)
      note(`.chart-label font resolves to ${charts.font}; widest "M/D" tick measures ${charts.widestTick.toFixed(1)}px`)
      // The page itself must not scroll sideways, however wide the chart track is.
      check(charts.docOverflow <= 1, 'AC-layout the Body view does not overflow the viewport horizontally',
        `document scrollWidth exceeds clientWidth by ${charts.docOverflow}px`)

      const dailyCharts = charts.charts.filter((ch) => /Steps|Sleep|Calories/.test(ch.title))
      check(dailyCharts.length === 3, 'AC5 all three daily charts render', `found: ${dailyCharts.map((c2) => c2.title).join(', ')}`)
      for (const ch of dailyCharts) {
        note(`"${ch.title}": ${ch.bars} bars across ${ch.chartWidth.toFixed(1)}px → ${ch.colWidth.toFixed(1)}px per column; ticks ${JSON.stringify(ch.ticks)}`)
        check(ch.labels === ch.bars, `AC5 "${ch.title}" labels every column with a date`,
          `${ch.labels}/${ch.bars} columns carry a non-empty .chart-label`)
        check(ch.ticks.every((t) => /^\d{1,2}\/\d{1,2}$/.test(t ?? '')), `AC5 "${ch.title}" ticks are M/D dates`,
          `ticks: ${JSON.stringify(ch.ticks)}`)
        check(ch.colWidth >= charts.widestTick, `AC5 "${ch.title}" leaves room for a per-column date tick`,
          `column is ${ch.colWidth.toFixed(1)}px, widest tick needs ${charts.widestTick.toFixed(1)}px at ${charts.fontSize}`)
        check(ch.buttons === ch.bars, `AC5 "${ch.title}" columns are real controls`, `${ch.buttons}/${ch.bars} are <button>`)
        check(ch.focusable === ch.bars, `AC5 "${ch.title}" columns are keyboard reachable`, `${ch.focusable}/${ch.bars} focusable`)
        check(ch.named === ch.bars, `AC5 "${ch.title}" columns expose an accessible name`, `${ch.named}/${ch.bars} have a non-empty aria-label`)
        check(ch.selected === 1, `AC5 "${ch.title}" marks exactly one selected column`, `${ch.selected} marked selected`)
        check(/\d/.test(ch.readout) && /\d{4}-\d{2}-\d{2}/.test(ch.readout),
          `AC5 "${ch.title}" writes the selected reading and its date out in text`, `readout reads "${ch.readout}"`)
        check(/reading/.test(ch.caption) && /not shown as zero/.test(ch.caption),
          `AC5 "${ch.title}" states how many readings the window holds`, `caption reads "${ch.caption}"`)
      }

      // --- AC5: a day with no reading is omitted, not drawn as zero.
      const steps = dailyCharts.find((x) => /Steps/.test(x.title))
      const cals = dailyCharts.find((x) => /Calories/.test(x.title))
      note(`seeded steps on 6 of the days in the window, calories on all of them`)
      check(steps?.bars === 6, 'AC5 a day with no steps reading is omitted rather than drawn as zero',
        `Steps rendered ${steps?.bars} bars for 6 readings`)
      check(cals?.bars >= 14, 'AC5 the dense case still renders every reading', `Calories rendered ${cals?.bars} bars`)

      // --- AC5: the readout follows a tap, and follows an arrow key.
      const calsReadout = async () => await ev(`(() => {
        const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Calories'))
        const cols = [...card.querySelectorAll('.chart-col')]
        return { text: card.querySelector('.chart-readout')?.textContent?.replace(/\\s+/g, ' ').trim(),
          selectedIndex: cols.findIndex((x) => x.classList.contains('selected')),
          names: cols.map((x) => x.getAttribute('aria-label')),
          focusedIndex: cols.indexOf(document.activeElement) } })()`)
      const before = await calsReadout()
      check(before.selectedIndex === before.names.length - 1, 'AC5 the newest reading starts selected',
        `selected index ${before.selectedIndex} of ${before.names.length}`)

      // Tap the third bar via a real click at its centre, not a dispatched event.
      const tapped = await ev(`(() => {
        const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Calories'))
        const col = card.querySelectorAll('.chart-col')[2]
        col.scrollIntoView({ block: 'center', inline: 'center' })
        const r = col.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: col.getAttribute('aria-label') } })()`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await dt.send('Input.dispatchMouseEvent', { type, x: tapped.x, y: tapped.y, button: 'left', clickCount: 1 })
      }
      await sleep(180)
      const afterTap = await calsReadout()
      const tappedDate = tapped.name.split(':')[0]
      check(afterTap.selectedIndex === 2 && afterTap.text.includes(tappedDate),
        'AC5 tapping a bar selects it and updates the readout',
        `tapped "${tapped.name}"; readout now "${afterTap.text}", selected index ${afterTap.selectedIndex}`)

      // Keyboard: the tapped button holds focus, so ArrowRight must walk one bar along.
      check(afterTap.focusedIndex === 2, 'AC5 tapping a bar gives it focus', `focused index ${afterTap.focusedIndex}`)
      await key('ArrowRight', 39)
      const afterKey = await calsReadout()
      check(afterKey.selectedIndex === 3 && afterKey.focusedIndex === 3,
        'AC5 an arrow key moves the selection and the focus together',
        `selected index ${afterKey.selectedIndex}, focused index ${afterKey.focusedIndex} (expected 3 and 3)`)
      check(afterKey.text.includes(afterKey.names[3].split(':')[0]), 'AC5 the readout follows the arrow key',
        `readout "${afterKey.text}" vs column name "${afterKey.names[3]}"`)

      await shoot(`tom43-charts-${c.name}.png`)

      // ---------------------------------------------------------------- Empty history
      // AC3's "empty history" half: no workouts and no metrics must render, not throw.
      await seed('[]', '[]')
      await openTab('History')
      await sleep(200)
      const emptyHistory = await ev(`(() => ({
        prRows: document.querySelectorAll('.pr-row').length,
        charts: document.querySelectorAll('.chart').length,
        text: document.querySelector('.view')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120) }))()`)
      check(emptyHistory.prRows === 0 && /No workouts yet/.test(emptyHistory.text ?? ''),
        'AC3 an empty history renders the empty state, not a Best lifts card',
        `${emptyHistory.prRows} pr-rows; view reads "${emptyHistory.text}"`)
      await openTab('Body')
      await sleep(200)
      const emptyBody = await ev(`(() => ({
        charts: document.querySelectorAll('.chart').length,
        readouts: document.querySelectorAll('.chart-readout').length,
        text: document.querySelector('.view')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) }))()`)
      check(emptyBody.charts === 0 && emptyBody.readouts === 0 && /No health data yet/.test(emptyBody.text ?? ''),
        'AC3 no metrics renders the empty state, not an empty chart',
        `${emptyBody.charts} charts, ${emptyBody.readouts} readouts; view reads "${emptyBody.text}"`)

      // A single reading must not divide by zero or render a half-chart.
      await seed('[]', `[{ "date": "2026-10-01", "steps": 7200, "updatedAt": 1, "source": "manual" }]`)
      await openTab('Body')
      await waitFor('single-bar chart', async () => await ev(`!!document.querySelector('.chart-col')`))
      const single = await ev(`(() => {
        const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Steps'))
        return { bars: card.querySelectorAll('.chart-col').length,
          caption: card.querySelector('.muted.small')?.textContent?.replace(/\\s+/g, ' ').trim(),
          readout: card.querySelector('.chart-readout')?.textContent?.replace(/\\s+/g, ' ').trim() } })()`)
      check(single.bars === 1 && /1 reading /.test(single.caption ?? ''), 'AC3 a single reading renders one dated bar',
        `${single.bars} bar(s); caption "${single.caption}", readout "${single.readout}"`)

      await dt.send('Target.closeTarget', { targetId }, undefined)
    }
  } finally { chrome.kill(); server.close() }

  console.log(`\n${pass} ok, ${failures.length} failure(s)`)
  console.log(`artifacts: ${OUT}`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(` - ${f}`)
  }
  // This one IS a gate: a regression must break the command that runs it.
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
