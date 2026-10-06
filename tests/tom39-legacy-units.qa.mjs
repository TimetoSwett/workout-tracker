#!/usr/bin/env node
// Browser evidence for the legacy-pounds half of TOM-39 / TOM-59.
//
// test/legacyWeights.check.ts already proves the tagging arithmetic. What it cannot show is
// whether the Settings UI actually reaches those states on a phone, so this drives the real
// built app in headless Chromium against an in-page fake Dropbox and asserts both the
// behaviour and the fit.
//
// The fake Dropbox is a fetch interceptor holding synthetic JSONL in memory. The seeded
// access token is the literal string "synthetic-qa-token"; no real credential, account or
// network request is involved, and every weight value below is invented.
//
// Scenarios, each at 360px and 390px:
//   A  unlabeled records -> bulk "all pounds" -> save: backup named, tags appended,
//      measurements byte-identical, numeric literals preserved
//   B  file with explicit kg labels -> conflict notice shown, kg labels never rewritten
//   C  invalid existing unit tag -> saving blocked, raw file untouched
//   D  backup read-back mismatch -> refuses to write, original file unchanged
//   E  repeated migration of an already-resolved file -> refuses, no second write
//   F  offline / network error -> surfaces the error, original file unchanged
//   G  expired grant (401) -> surfaces a reconnect message rather than writing
//   H  every status/alert string is fully in the DOM and the page never scrolls sideways
//
//   npm run build && node tests/tom39-legacy-units.qa.mjs [--out <dir>]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom39-units-evidence-'))
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first')
  process.exit(1)
}
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

// --- synthetic fixtures. Odd precision on purpose: a migration that rounds will show up.
const UNLABELED_WORKOUTS = [
  '{"id":"w1","date":"2026-02-01","name":"Push A","exercises":[{"name":"Bench","sets":[{"weight":137.5,"reps":8}]}]}',
  '{"id":"w2","date":"2026-02-03","name":"Pull A","exercises":[{"name":"Row","sets":[{"weight":92.25,"reps":10}]}]}',
].join('\n')
const MIXED_KG_WORKOUTS = [
  '{"id":"w1","date":"2026-02-01","name":"Push A","exercises":[{"name":"Bench","sets":[{"weight":137.5,"reps":8}]}]}',
  '{"id":"w2","date":"2026-02-03","name":"Pull A","weightUnit":"kg","exercises":[{"name":"Row","sets":[{"weight":62.5,"reps":10}]}]}',
].join('\n')
const INVALID_TAG_WORKOUTS = [
  '{"id":"w1","date":"2026-02-01","name":"Push A","exercises":[{"name":"Bench","sets":[{"weight":137.5,"reps":8}]}]}',
  '{"id":"w2","date":"2026-02-03","name":"Pull A","weightUnit":"pounds","exercises":[{"name":"Row","sets":[{"weight":92.25,"reps":10}]}]}',
].join('\n')
const ALL_LABELLED = [
  '{"id":"w1","date":"2026-02-01","name":"Push A","weightUnit":"lbs","exercises":[{"name":"Bench","sets":[{"weight":137.5,"reps":8}]}]}',
].join('\n')

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
]

const results = []
const failures = []
function record(vp, name, pass, detail = '') {
  results.push({ viewport: vp, name, pass, detail })
  if (!pass) failures.push(`[${vp}] ${name}${detail ? `: ${detail}` : ''}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

/** Installed before any app code runs. Holds the fake Dropbox file system and a fault switch. */
const FAKE_DROPBOX = `
window.__db = {
  files: {},
  mode: 'ok',            // 'ok' | 'corrupt-backup' | 'offline' | 'unauthorized'
  uploads: [],
  downloads: [],
}
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  if (!/dropboxapi\\.com/.test(url)) return realFetch(input, init)
  const db = window.__db
  const arg = JSON.parse((init?.headers?.['Dropbox-API-Arg']) ?? '{}')
  if (db.mode === 'offline') throw new TypeError('Failed to fetch')
  if (db.mode === 'unauthorized') return new Response('invalid_access_token', { status: 401 })
  if (/files\\/download/.test(url)) {
    db.downloads.push(arg.path)
    const f = db.files[arg.path]
    if (!f) return new Response('path/not_found/...', { status: 409 })
    // The corrupt-backup fault returns altered bytes for the backup read-back only.
    const body = db.mode === 'corrupt-backup' && /before-units-/.test(arg.path) ? f.content + '\\n{"tampered":true}' : f.content
    return new Response(body, { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: f.rev }) } })
  }
  if (/files\\/upload/.test(url)) {
    const body = typeof init.body === 'string' ? init.body : String(init.body)
    db.uploads.push({ path: arg.path, mode: arg.mode, bytes: body })
    const existing = db.files[arg.path]
    if (arg.mode === 'add' && existing) return new Response('conflict', { status: 409 })
    if (arg.mode && arg.mode['.tag'] === 'update' && existing && existing.rev !== arg.mode.update) {
      return new Response('conflict', { status: 409 })
    }
    db.files[arg.path] = { content: body, rev: 'rev' + (db.uploads.length + 100) }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('{}', { status: 200 })
}
`

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom39-units-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })

  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    for (const vp of VIEWPORTS) {
      console.log(`\n=== ${vp.name} ===`)
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
      dt.sessionId = sessionId
      await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })
      await dt.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: true })
      await dt.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_DROPBOX })

      const ev = async (expression) => {
        const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
        return result.value
      }
      const shot = async (label) => {
        const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(OUT, `${vp.name}-${label}.png`), Buffer.from(data, 'base64'))
      }

      // Boot once to get an origin, seed a synthetic connected-Dropbox settings slice, reload.
      await dt.send('Page.navigate', { url: base })
      await waitFor('paint', async () => await ev(`!!document.querySelector('.app')`))
      const seed = async (content, mode = 'ok') => {
        await ev(`(() => {
          localStorage.setItem('wt.active.v1', JSON.stringify({ active: null, templates: [], settings: {
            units: 'lbs', restSeconds: 90, philosophy: 'balanced',
            dropboxToken: 'synthetic-qa-token', dropboxTokenExpiresAt: ${Date.now() + 86_400_000} } }))
          localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
          return true })()`)
        await dt.send('Page.navigate', { url: base })
        await waitFor('app', async () => await ev(`!!document.querySelector('.tabbar')`))
        await ev(`(() => { window.__db.files['/workouts.jsonl'] = { content: ${JSON.stringify(content)}, rev: 'rev1' }
          window.__db.mode = ${JSON.stringify(mode)}; window.__db.uploads = []; window.__db.downloads = []; return true })()`)
        // Open Settings and expand the legacy-weights disclosure.
        await ev(`[...document.querySelectorAll('.tabbar button')].find(b => /setting/i.test(b.textContent)).click()`)
        await waitFor('settings', async () => await ev(`!!document.querySelector('details summary')`))
        await ev(`(() => { const d = [...document.querySelectorAll('details')].find(x => /Resolve legacy weight units/.test(x.textContent))
          d.open = true; d.scrollIntoView({ block: 'center' }); return true })()`)
        await sleep(200)
      }
      const reviewWorkouts = async () => {
        await ev(`[...document.querySelectorAll('details button')].find(b => /Review workouts/.test(b.textContent)).click()`)
        await sleep(600)
      }
      const texts = () => ev(`[...document.querySelectorAll('details p, details [role=alert], details [role=status]')].map(e => e.textContent.trim())`)
      const fit = () => ev(`(() => {
        const bad = [...document.querySelectorAll('details p, details [role=alert], details [role=status], details button')]
          .filter(e => e.getBoundingClientRect().width > 0)
          .filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > window.innerWidth + 1)
          .map(e => ({ tag: e.tagName, text: e.textContent.trim().slice(0, 60), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, right: Math.round(e.getBoundingClientRect().right) }))
        return { overflowing: bad, docScrollWidth: document.documentElement.scrollWidth, docClientWidth: document.documentElement.clientWidth }
      })()`)
      const fileNow = () => ev(`window.__db.files['/workouts.jsonl'].content`)
      const uploads = () => ev(`window.__db.uploads.map(u => ({ path: u.path, mode: typeof u.mode === 'string' ? u.mode : u.mode['.tag'] }))`)
      const saveDisabled = () => ev(`(() => { const b = [...document.querySelectorAll('details button')].find(x => /Back up raw file and save/.test(x.textContent)); return b ? b.disabled : 'absent' })()`)
      const clickBulkPounds = () => ev(`[...document.querySelectorAll('details button')].find(b => /entered all unlabeled records in pounds/.test(b.textContent)).click()`)
      const clickSave = () => ev(`[...document.querySelectorAll('details button')].find(b => /Back up raw file and save/.test(b.textContent)).click()`)

      // ---------------- A: bulk pounds on unlabeled records ----------------
      await seed(UNLABELED_WORKOUTS)
      await reviewWorkouts()
      let t = await texts()
      record(vp.name, 'A: unresolved count is reported for unlabeled records',
        t.some((x) => /2 unresolved records/.test(x)), t.find((x) => /unresolved/.test(x)) ?? 'no count shown')
      record(vp.name, 'A: per-record unit selectors are offered',
        (await ev(`document.querySelectorAll('details select').length`)) === 2,
        `${await ev(`document.querySelectorAll('details select').length`)} selectors`)
      record(vp.name, 'A: save is blocked until every record has a unit', (await saveDisabled()) === true, `disabled=${await saveDisabled()}`)
      await shot('A-unresolved')
      await clickBulkPounds()
      await sleep(300)
      record(vp.name, 'A: bulk pounds selection enables save', (await saveDisabled()) === false, `disabled=${await saveDisabled()}`)
      record(vp.name, 'A: bulk pounds sets every selector to lbs',
        await ev(`[...document.querySelectorAll('details select')].every(s => s.value === 'lbs')`),
        (await ev(`[...document.querySelectorAll('details select')].map(s => s.value).join(',')`)))
      await clickSave()
      await waitFor('save status', async () => (await texts()).some((x) => /Units saved|failed|Error/i.test(x)))
      t = await texts()
      const status = t.find((x) => /Units saved|failed|Error/i.test(x)) ?? ''
      record(vp.name, 'A: save reports success and names the raw Dropbox backup',
        /Units saved without changing measurements/.test(status) && /before-units-/.test(status), status.slice(0, 120))
      record(vp.name, 'A: status tells the user to sync again and keep the backup',
        /Sync again to import/.test(status) && /Keep this backup for recovery/.test(status), '')
      const up = await uploads()
      record(vp.name, 'A: a create-only backup is written before the file is replaced',
        up.length === 2 && /before-units-/.test(up[0].path) && up[0].mode === 'add' && up[1].path === '/workouts.jsonl' && up[1].mode === 'update',
        JSON.stringify(up))
      const tagged = await fileNow()
      record(vp.name, 'A: every record is tagged lbs',
        tagged.split('\n').every((l) => JSON.parse(l).weightUnit === 'lbs'), '')
      record(vp.name, 'A: measurements are byte-identical — no rounding, no reserialization',
        tagged.split('\n').map((l) => l.replace(',"weightUnit":"lbs"', '')).join('\n') === UNLABELED_WORKOUTS,
        tagged.includes('137.5') && tagged.includes('92.25') ? 'literals 137.5 and 92.25 preserved' : 'LITERALS CHANGED')
      let f = await fit()
      record(vp.name, 'A: status text fits without clipping or sideways scroll',
        f.overflowing.length === 0 && f.docScrollWidth <= f.docClientWidth,
        f.overflowing.length ? JSON.stringify(f.overflowing) : `doc ${f.docScrollWidth}/${f.docClientWidth}`)
      await shot('A-saved')

      // ---------------- E: repeating the migration ----------------
      await reviewWorkouts()
      t = await texts()
      record(vp.name, 'E: a re-review of the now-resolved file reports nothing left to do',
        t.some((x) => /All records already have units/.test(x)), t.join(' | ').slice(0, 120))
      record(vp.name, 'E: no save control is offered on a resolved file', (await saveDisabled()) === 'absent', `save button ${await saveDisabled()}`)

      // ---------------- B: explicit kg labels present ----------------
      await seed(MIXED_KG_WORKOUTS)
      await reviewWorkouts()
      t = await texts()
      const kgAlert = await ev(`[...document.querySelectorAll('details [role=alert]')].map(e => e.textContent.trim())`)
      record(vp.name, 'B: an explicit-kg file raises a conflict notice as an alert',
        kgAlert.some((x) => /contains explicit kg labels/.test(x)), kgAlert.join(' | ').slice(0, 160))
      record(vp.name, 'B: the notice promises the kg labels will not be overwritten',
        kgAlert.some((x) => /will not be overwritten/.test(x)), '')
      record(vp.name, 'B: only the untagged record is listed as unresolved',
        t.some((x) => /1 unresolved records/.test(x)) && (await ev(`document.querySelectorAll('details select').length`)) === 1,
        t.find((x) => /unresolved/.test(x)) ?? '')
      await shot('B-kg-conflict')
      await clickBulkPounds(); await sleep(200); await clickSave()
      await waitFor('kg-case status', async () => (await texts()).some((x) => /Units saved|failed|Error/i.test(x)))
      const kgFile = await fileNow()
      record(vp.name, 'B: the pre-existing kg label survives the migration untouched',
        JSON.parse(kgFile.split('\n')[1]).weightUnit === 'kg' && kgFile.includes('"weight":62.5'),
        `line 2 unit ${JSON.parse(kgFile.split('\n')[1]).weightUnit}`)
      record(vp.name, 'B: the untagged record is tagged lbs without altering its measurement',
        JSON.parse(kgFile.split('\n')[0]).weightUnit === 'lbs' && kgFile.includes('"weight":137.5'), '')
      f = await fit()
      record(vp.name, 'B: the conflict notice fits the viewport',
        f.overflowing.length === 0 && f.docScrollWidth <= f.docClientWidth,
        f.overflowing.length ? JSON.stringify(f.overflowing) : 'fits')

      // ---------------- C: an invalid existing unit tag ----------------
      await seed(INVALID_TAG_WORKOUTS)
      await reviewWorkouts()
      const invalidAlert = await ev(`[...document.querySelectorAll('details [role=alert]')].map(e => e.textContent.trim())`)
      record(vp.name, 'C: an invalid existing unit tag is called out as an alert',
        invalidAlert.some((x) => /existing unit label is invalid/.test(x)), invalidAlert.join(' | ').slice(0, 160))
      record(vp.name, 'C: saving is blocked while an invalid tag is present',
        (await saveDisabled()) === true, `disabled=${await saveDisabled()}`)
      await clickBulkPounds(); await sleep(250)
      record(vp.name, 'C: bulk pounds does not unlock saving past an invalid tag',
        (await saveDisabled()) === true, `disabled=${await saveDisabled()}`)
      record(vp.name, 'C: nothing was uploaded while blocked', (await uploads()).length === 0, JSON.stringify(await uploads()))
      record(vp.name, 'C: the raw file is unchanged', (await fileNow()) === INVALID_TAG_WORKOUTS, '')
      await shot('C-invalid-tag')

      // ---------------- D: backup read-back verification ----------------
      await seed(UNLABELED_WORKOUTS, 'corrupt-backup')
      await reviewWorkouts()
      await clickBulkPounds(); await sleep(200); await clickSave()
      await waitFor('read-back status', async () => (await texts()).some((x) => /verification failed|Units saved/i.test(x)))
      const dStatus = (await texts()).find((x) => /verification failed|Units saved/i.test(x)) ?? ''
      record(vp.name, 'D: a backup that does not read back identically aborts the migration',
        /Backup recovery verification failed/.test(dStatus), dStatus.slice(0, 140))
      record(vp.name, 'D: the abort message states the original file is unchanged and names the backup',
        /original file unchanged/.test(dStatus) && /before-units-/.test(dStatus), '')
      record(vp.name, 'D: the data file really was never written',
        (await fileNow()) === UNLABELED_WORKOUTS &&
          !(await uploads()).some((u) => u.path === '/workouts.jsonl'),
        JSON.stringify(await uploads()))
      f = await fit()
      record(vp.name, 'D: the long failure message fits without clipping',
        f.overflowing.length === 0 && f.docScrollWidth <= f.docClientWidth,
        f.overflowing.length ? JSON.stringify(f.overflowing) : 'fits')
      await shot('D-readback-rejected')

      // ---------------- F: offline ----------------
      await seed(UNLABELED_WORKOUTS)
      await reviewWorkouts()
      await clickBulkPounds(); await sleep(200)
      await ev(`(() => { window.__db.mode = 'offline'; return true })()`)
      await clickSave()
      await waitFor('offline status', async () => (await texts()).some((x) => /Error|failed|Network/i.test(x)))
      const offline = (await texts()).find((x) => /Error|failed|Network/i.test(x)) ?? ''
      record(vp.name, 'F: an offline save surfaces a network error instead of silently passing',
        /Network error|Backup failed/i.test(offline), offline.slice(0, 140))
      record(vp.name, 'F: the data file is untouched after an offline save',
        (await fileNow()) === UNLABELED_WORKOUTS, '')
      await shot('F-offline')

      // ---------------- G: expired grant ----------------
      await seed(UNLABELED_WORKOUTS, 'unauthorized')
      await reviewWorkouts()
      const gStatus = (await texts()).join(' | ')
      record(vp.name, 'G: an expired grant surfaces a reconnect/auth message on review',
        /reconnect|Reconnect|401|not connected/i.test(gStatus), gStatus.slice(0, 160))
      record(vp.name, 'G: no unit selectors are offered when the file could not be read',
        (await ev(`document.querySelectorAll('details select').length`)) === 0, '')
      await shot('G-unauthorized')

      // ---------------- H: a file that is already fully labelled ----------------
      await seed(ALL_LABELLED)
      await reviewWorkouts()
      record(vp.name, 'H: a fully labelled file reports no work and offers no save',
        (await texts()).some((x) => /All records already have units/.test(x)) && (await saveDisabled()) === 'absent', '')
      f = await fit()
      record(vp.name, 'H: the collapsed/expanded disclosure never scrolls the page sideways',
        f.docScrollWidth <= f.docClientWidth, `doc ${f.docScrollWidth}/${f.docClientWidth}`)

      await dt.send('Target.closeTarget', { targetId }, undefined)
      dt.sessionId = undefined
    }
  } finally { chrome.kill(); server.close() }

  const passed = results.filter((r) => r.pass).length
  writeFileSync(join(OUT, 'legacy-units-results.json'), JSON.stringify(results, null, 2))
  console.log(`\n${passed}/${results.length} checks passed`)
  console.log(`evidence: ${OUT}`)
  if (failures.length) { console.log('\nfailures:'); for (const x of failures) console.log(`  - ${x}`); process.exitCode = 1 }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
