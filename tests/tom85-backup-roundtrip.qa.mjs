#!/usr/bin/env node
// TOM-85 delta gate: the only behavioural change between `e2c7e2d` (the SHA the board accepted
// on their phone) and the consolidated `fa3e49b` is PR 28's unit-safe JSON backup path. The
// unit tests in `test/workoutBackup.check.ts` cover the module; nothing covered the *wiring*
// in `src/components/SettingsView.tsx`, which is the other half of the diff.
//
// This drives the real Settings "Data" card in a browser: Export workouts JSON, feed the
// produced file back through the real <input type=file>, and assert on what actually lands in
// localStorage. Synthetic data only — no real body weights anywhere in this file.
//
// Usage: npm run build && node tests/tom85-backup-roundtrip.qa.mjs
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

const failures = []
function record(name, pass, detail) {
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// Synthetic workouts. Deliberately awkward numbers: a long decimal that only survives if
// nothing rounds, a null weight (bodyweight set), an explicit zero, and a tombstone that
// must never be exported.
const KEEP = [
  {
    id: 'qa-w1', date: '2026-01-02', startedAt: 1767312000000, name: 'QA Push A', bodyweight: 183.37,
    exercises: [
      { id: 'e1', name: 'Bench Press', sets: [
        { weight: 137.5, reps: 8, done: true },
        { weight: 0, reps: 12, done: true },
        { weight: null, reps: 10, done: true },
        { weight: 212.34567, reps: 3, done: true, weightTarget: 215.5 },
      ] },
      { id: 'e2', name: 'Overhead Press', sets: [{ weight: 95.1, reps: 6, done: true }] },
    ],
  },
  {
    id: 'qa-w2', date: '2026-01-04', startedAt: 1767484800000, name: 'QA Pull A',
    exercises: [{ id: 'e3', name: 'Row', sets: [{ weight: 110.25, reps: 10, done: true }] }],
  },
]
const TOMBSTONE = { id: 'qa-deleted', date: '2026-01-03', startedAt: 1767398400000, name: 'QA Deleted', deleted: true, exercises: [] }
const ALL = [...KEEP, TOMBSTONE]

const KG_TO_LB = 2.2046226
const toKg = (v) => v == null ? v : v / KG_TO_LB
const toLb = (v) => v == null ? v : v * KG_TO_LB

// Every weight in a workout list, flattened in a stable order, for comparison.
const weightsOf = (list) => list.flatMap((w) => [w.bodyweight ?? null, ...w.exercises.flatMap((ex) => ex.sets.flatMap((s) => [s.weight ?? null, s.weightTarget ?? null]))])

const SEED = (units, workouts) => `(() => {
  localStorage.setItem('wt.active.v1', JSON.stringify({
    active: null, templates: [],
    settings: { units: '${units}', restSeconds: 90, philosophy: 'balanced' },
  }))
  localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: ${JSON.stringify(workouts)}, mesocycles: [] }))
})()`

// Feeds `text` through the real file input the way a file picker would. Preact binds the
// native `change` event, so a bubbling change on the input is the genuine code path.
const FEED = (text) => `(async () => {
  const label = [...document.querySelectorAll('.file-btn')].find((l) => /Import workouts JSON/.test(l.textContent))
  if (!label) throw new Error('Import workouts JSON control not found')
  const input = label.querySelector('input[type=file]')
  const dt = new DataTransfer()
  dt.items.add(new File([${JSON.stringify(text)}], 'workouts.json', { type: 'application/json' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`

const STORED = `(() => JSON.parse(localStorage.getItem('wt.history.v1')).workouts)()`
const TOAST = `(() => document.querySelector('.toast')?.textContent ?? null)()`
const LEGACY_PROMPT = `(() => !!document.querySelector('[aria-label="Legacy workout import units"]'))()`

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom85-chrome-'))
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
    await dt.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true })

    const run = async (expression, userGesture = false) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const tap = (e) => run(e, true)

    // Loads the app with the given seed and lands on the Settings tab with the Data card visible.
    async function openSettings(units, workouts) {
      await dt.send('Page.navigate', { url: base })
      await waitFor('first paint', async () => await run(`!!document.querySelector('.app')`))
      await run(SEED(units, workouts))
      await dt.send('Page.navigate', { url: base })
      await waitFor('tab bar', async () => await run(`!!document.querySelector('.tabbar button')`))
      await tap(`[...document.querySelectorAll('.tabbar button')].find((b) => /Settings/.test(b.textContent)).click()`)
      await waitFor('data card', async () => await run(`!!document.querySelector('.file-btn')`))
    }

    // Captures what Export workouts JSON would hand the download, without a download.
    async function exportJson() {
      await run(`(() => {
        window.__qaExport = null
        if (!window.__qaPatched) {
          window.__qaPatched = true
          const real = URL.createObjectURL.bind(URL)
          URL.createObjectURL = (blob) => { window.__qaBlob = blob; return real(blob) }
          const click = HTMLAnchorElement.prototype.click
          HTMLAnchorElement.prototype.click = function () { if (this.download) return; return click.call(this) }
        }
      })()`)
      await tap(`[...document.querySelectorAll('.btn')].find((b) => /Export workouts JSON/.test(b.textContent)).click()`)
      return await run(`(async () => window.__qaBlob ? await window.__qaBlob.text() : null)()`)
    }

    // `flash()` clears the status with a bare 4s setTimeout it never cancels, so a message set
    // while a previous flash's timer is still pending gets wiped early. That is pre-existing
    // behaviour (`flash` is untouched by this diff) but it would make back-to-back cases in the
    // malformed table read as "no message at all". Drain the toast before each feed so every
    // assertion below is about the file it fed, not about the one before it.
    async function drainToast() {
      await waitFor('previous toast to clear', async () => (await run(TOAST)) === null, 6000)
    }
    async function feed(text) {
      await run(FEED(text), true)
      await sleep(400)
      return { toast: await run(TOAST), stored: await run(STORED), prompt: await run(LEGACY_PROMPT) }
    }

    // ---- 1. Export shape: versioned, unit-tagged, workouts only, tombstones excluded ----
    console.log('\n==== export envelope (app in lbs) ====')
    await openSettings('lbs', ALL)
    const exportedLbs = await exportJson()
    record('Export workouts JSON produces a file', !!exportedLbs, exportedLbs ? `${exportedLbs.length} bytes` : 'nothing captured')
    const env1 = JSON.parse(exportedLbs)
    record('envelope is format/version tagged', env1.format === 'workout-tracker-workouts' && env1.version === 1, `format=${env1.format} version=${env1.version}`)
    record('envelope records the export units', env1.weightUnit === 'lbs', `weightUnit=${env1.weightUnit}`)
    record('envelope carries only the live workouts', Array.isArray(env1.workouts) && env1.workouts.length === KEEP.length, `${env1.workouts?.length} of ${ALL.length} records`)
    record('tombstones are not exported', !env1.workouts.some((w) => w.deleted || w.id === 'qa-deleted'), `ids=${env1.workouts.map((w) => w.id).join(',')}`)
    record('export leaks no settings, metrics, plans or credentials',
      Object.keys(env1).sort().join(',') === 'format,version,weightUnit,workouts'.split(',').sort().join(','), `keys=${Object.keys(env1).join(',')}`)
    record('export preserves the long decimal exactly', JSON.stringify(weightsOf(env1.workouts)) === JSON.stringify(weightsOf(KEEP)),
      `${JSON.stringify(weightsOf(env1.workouts))}`)

    // ---- 2. Same-unit restore: byte-exact, nulls preserved, tombstones kept ----
    console.log('\n==== same-unit restore into an empty history (lbs -> lbs) ====')
    await openSettings('lbs', [TOMBSTONE])
    const same = await feed(exportedLbs)
    record('same-unit import reports what it added', /Imported \(2 new\)/.test(same.toast ?? ''), `toast="${same.toast}"`)
    const sameLive = same.stored.filter((w) => !w.deleted)
    record('same-unit import is numerically exact', JSON.stringify(weightsOf(sameLive)) === JSON.stringify(weightsOf(KEEP)),
      `${JSON.stringify(weightsOf(sameLive))} vs ${JSON.stringify(weightsOf(KEEP))}`)
    record('null set weight survives as null', sameLive[0].exercises[0].sets[2].weight === null, `${JSON.stringify(sameLive[0].exercises[0].sets[2])}`)
    record('explicit zero is not dropped or nulled', sameLive[0].exercises[0].sets[1].weight === 0, `${JSON.stringify(sameLive[0].exercises[0].sets[1])}`)
    record('existing tombstone survives the import', same.stored.some((w) => w.id === 'qa-deleted' && w.deleted), `ids=${same.stored.map((w) => w.id).join(',')}`)
    const again = await feed(exportedLbs)
    record('re-import is idempotent (existing ids win)', again.stored.length === same.stored.length && /Imported \(0 new\)/.test(again.toast ?? ''),
      `${same.stored.length} -> ${again.stored.length}, toast="${again.toast}"`)

    // ---- 3. lbs -> kg -> lbs round trip through two real imports ----
    console.log('\n==== cross-unit round trip (lbs -> kg -> lbs) ====')
    await openSettings('kg', [])
    const intoKg = await feed(exportedLbs)
    const kgLive = intoKg.stored.filter((w) => !w.deleted)
    const wantKg = weightsOf(KEEP).map(toKg)
    const gotKg = weightsOf(kgLive)
    const kgWorst = Math.max(...gotKg.map((v, i) => Math.abs((v ?? 0) - (wantKg[i] ?? 0))))
    record('a lbs file imported on a kg phone converts (unrounded)', kgWorst < 1e-10, `worst delta ${kgWorst}`)
    record('kg import still reports the right count', /Imported \(2 new\)/.test(intoKg.toast ?? ''), `toast="${intoKg.toast}"`)
    const exportedKg = await exportJson()
    const env2 = JSON.parse(exportedKg)
    record('the re-export is tagged kg, not lbs', env2.weightUnit === 'kg', `weightUnit=${env2.weightUnit}`)
    await openSettings('lbs', [])
    const backToLbs = await feed(exportedKg)
    const lbsLive = backToLbs.stored.filter((w) => !w.deleted)
    const want = weightsOf(KEEP)
    const got = weightsOf(lbsLive)
    const worst = Math.max(...got.map((v, i) => Math.abs((v ?? 0) - (want[i] ?? 0))))
    record('lbs -> kg -> lbs returns the original weights within 1e-10', worst < 1e-10, `worst delta ${worst}`)
    record('nulls survive the cross-unit round trip', lbsLive[0].exercises[0].sets[2].weight === null, `${JSON.stringify(lbsLive[0].exercises[0].sets[2])}`)
    record('reps, names, ids and dates are untouched by conversion',
      JSON.stringify(lbsLive.map((w) => ({ id: w.id, date: w.date, name: w.name, reps: w.exercises.flatMap((e) => e.sets.map((s) => s.reps)) }))) ===
      JSON.stringify(KEEP.map((w) => ({ id: w.id, date: w.date, name: w.name, reps: w.exercises.flatMap((e) => e.sets.map((s) => s.reps)) }))), 'structural fields compared')

    // ---- 4. Legacy bare array: prompt, cancel writes nothing, choice converts ----
    console.log('\n==== legacy unlabelled array ====')
    await openSettings('kg', [])
    const legacy = await feed(JSON.stringify(KEEP))
    record('a bare legacy array does not import silently', legacy.stored.length === 0, `${legacy.stored.length} record(s) written`)
    record('a bare legacy array raises the units prompt', legacy.prompt, `prompt visible=${legacy.prompt}`)
    await tap(`[...document.querySelectorAll('.btn')].find((b) => /Cancel import/.test(b.textContent)).click()`)
    await sleep(300)
    const cancelled = await run(STORED)
    record('Cancel import writes nothing', cancelled.length === 0, `${cancelled.length} record(s) written`)
    record('Cancel import dismisses the prompt', !(await run(LEGACY_PROMPT)), 'prompt gone')

    await feed(JSON.stringify(KEEP))
    await tap(`[...document.querySelectorAll('.btn')].find((b) => /Import from pounds/.test(b.textContent)).click()`)
    await sleep(400)
    const chose = await run(STORED)
    const choseWorst = Math.max(...weightsOf(chose.filter((w) => !w.deleted)).map((v, i) => Math.abs((v ?? 0) - (wantKg[i] ?? 0))))
    record('"Import from pounds" on a kg phone converts lbs -> kg', chose.length === 2 && choseWorst < 1e-10, `${chose.length} records, worst delta ${choseWorst}`)

    await openSettings('lbs', [])
    await feed(JSON.stringify(KEEP.map((w) => ({ ...w }))))
    await tap(`[...document.querySelectorAll('.btn')].find((b) => /Import from kilograms/.test(b.textContent)).click()`)
    await sleep(400)
    const asKg = await run(STORED)
    const wantFromKg = weightsOf(KEEP).map(toLb)
    const kgChoiceWorst = Math.max(...weightsOf(asKg).map((v, i) => Math.abs((v ?? 0) - (wantFromKg[i] ?? 0))))
    record('"Import from kilograms" on a lbs phone converts kg -> lbs', asKg.length === 2 && kgChoiceWorst < 1e-10, `${asKg.length} records, worst delta ${kgChoiceWorst}`)

    // ---- 5. Malformed files must reject atomically ----
    console.log('\n==== malformed input rejects atomically ====')
    const BAD = [
      ['not JSON at all', '{ this is not json'],
      ['unknown format', JSON.stringify({ format: 'something-else', version: 1, weightUnit: 'lbs', workouts: KEEP })],
      ['future version', JSON.stringify({ format: 'workout-tracker-workouts', version: 2, weightUnit: 'lbs', workouts: KEEP })],
      ['missing weightUnit', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, workouts: KEEP })],
      ['invalid weightUnit', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, weightUnit: 'stone', workouts: KEEP })],
      ['workouts not an array', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, weightUnit: 'lbs', workouts: { nope: true } })],
      ['bad record in the middle', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, weightUnit: 'lbs', workouts: [KEEP[0], { id: '', startedAt: 'nope' }, KEEP[1]] })],
      ['non-numeric set weight', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, weightUnit: 'lbs', workouts: [{ id: 'x', startedAt: 1, exercises: [{ id: 'e', sets: [{ weight: '135', reps: 5 }] }] }] })],
      ['NaN set weight', '{"format":"workout-tracker-workouts","version":1,"weightUnit":"lbs","workouts":[{"id":"x","startedAt":1,"exercises":[{"id":"e","sets":[{"weight":1e999,"reps":5}]}]}]}'],
      ['conflicting per-record units', JSON.stringify({ format: 'workout-tracker-workouts', version: 1, weightUnit: 'lbs', workouts: [{ ...KEEP[0], weightUnit: 'kg' }] })],
    ]
    await openSettings('lbs', ALL)
    const before = JSON.stringify(await run(STORED))
    for (const [label, text] of BAD) {
      await drainToast()
      const res = await feed(text)
      const unchanged = JSON.stringify(res.stored) === before
      record(`rejects "${label}" with a message and no write`, /^Import failed:/.test(res.toast ?? '') && unchanged && !res.prompt,
        `toast="${res.toast}" storeUnchanged=${unchanged} prompt=${res.prompt}`)
    }
    record('store is byte-identical after every rejection', JSON.stringify(await run(STORED)) === before, 'compared against the pre-test snapshot')

    // ---- 6. The Data card itself, at the narrowest phone ----
    console.log('\n==== Data card layout at 320px ====')
    await dt.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true })
    await openSettings('lbs', KEEP)
    await feed(JSON.stringify(KEEP))
    const layout = await run(`(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => /^Data/.test(c.querySelector('h3')?.textContent ?? ''))
      const prompt = document.querySelector('[aria-label="Legacy workout import units"]')
      const btns = [...(prompt ?? card).querySelectorAll('.btn')]
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x*100)/100, w: Math.round(b.width*100)/100, right: Math.round(b.right*100)/100 } }
      return {
        hOverflow: document.documentElement.scrollWidth > innerWidth,
        cardClipped: card.scrollWidth > card.clientWidth + 1,
        promptVisible: !!prompt,
        buttons: btns.map((b) => ({ text: b.textContent.trim(), ...r(b), clipped: b.scrollWidth > b.clientWidth + 1 })),
        innerWidth,
      }
    })()`)
    record('320px: no horizontal page overflow with the units prompt open', !layout.hOverflow, `scrollWidth>innerWidth=${layout.hOverflow}`)
    record('320px: the Data card does not scroll sideways', !layout.cardClipped, `cardClipped=${layout.cardClipped}`)
    record('320px: the legacy prompt is on screen', layout.promptVisible, `visible=${layout.promptVisible}`)
    for (const b of layout.buttons) {
      record(`320px: "${b.text}" fits its box`, !b.clipped && b.x >= -0.5 && b.right <= layout.innerWidth + 0.5, `x=${b.x} w=${b.w} right=${b.right} clipped=${b.clipped} viewport=${layout.innerWidth}`)
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
  console.log('All TOM-85 backup round-trip checks passed.')
}

main().catch((err) => { console.error(err); process.exit(1) })
