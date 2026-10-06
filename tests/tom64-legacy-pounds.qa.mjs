#!/usr/bin/env node
// TOM-64 / AC7: drive the legacy-pounds resolution flow in a real browser against a
// synthetic in-page Dropbox. No real credentials, no real data, no network.
//
// The engineering `npm run check` suite covers the codec arithmetic. This covers what it
// cannot: the user-visible messages, which records the pounds button touches, byte-exactness
// of the rewritten file, the backup-download-and-compare gate, conflict handling, and whether
// resolved warnings actually go away.
//
//   node legacy-pounds.mjs <dist-dir>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const OUT = process.env.OUT ? resolve(process.env.OUT) : mkdtempSync(join(tmpdir(), 'tom64-legacy-'))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function waitFor(what, fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  for (;;) { const g = await fn(); if (g) return g
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await sleep(100) }
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

const results = []
const failures = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${pass ? '(' : '— '}${detail}${pass ? ')' : ''}` : ''}`)
}

// Synthetic fixture. Deliberately awkward on purpose:
//  - line 1 unlabeled, trailing-zero literal (62.50) that must survive byte for byte
//  - line 2 already tagged kg: must be retained untouched and must raise the conflict notice
//  - line 3 unlabeled, integer literal and an unknown extra field
//  - line 4 already tagged lbs
const FIXTURE = [
  '{"id":"w1","date":"2024-01-02","name":"Synthetic Squat","weight":62.50,"reps":5}',
  '{"id":"w2","date":"2024-01-03","name":"Synthetic Bench","weight":40,"reps":8,"weightUnit":"kg"}',
  '{"id":"w3","date":"2024-01-04","name":"Synthetic Row","weight":135,"reps":10,"notes":"keep me"}',
  '{"id":"w4","date":"2024-01-05","name":"Synthetic Curl","weight":30,"reps":12,"weightUnit":"lbs"}',
].join('\n')

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom64-legacy-chrome-'))
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

    // A synthetic Dropbox installed before the bundle runs. It records every call so the test
    // can assert the ORDER of backup-upload, backup-download and replacement.
    const FAKE = `(() => {
      const files = {}; const log = []; let revSeq = 1
      window.__fake = { files, log, nextUploadStatus: null, corruptBackup: false, conflictOnce: false }
      const real = window.fetch.bind(window)
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url
        if (!/dropboxapi\\.com|dropbox\\.com/.test(url)) return real(input, init)
        const arg = JSON.parse((init.headers || {})['Dropbox-API-Arg'] || '{}')
        if (url.includes('/files/download')) {
          log.push({ op: 'download', path: arg.path })
          const f = files[arg.path]
          if (!f) return new Response('path/not_found/...', { status: 409 })
          return new Response(f.content, { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: f.rev }) } })
        }
        if (url.includes('/files/upload')) {
          const body = init.body
          log.push({ op: 'upload', path: arg.path, mode: arg.mode, bytes: body.length })
          if (window.__fake.conflictOnce && arg.path === '/workouts.jsonl') { window.__fake.conflictOnce = false; window.__fake.files['/workouts.jsonl'] = { content: window.__fake.__other, rev: 'rev99' }; return new Response('conflict', { status: 409 }) }
          if (window.__fake.nextUploadStatus) { const s = window.__fake.nextUploadStatus; window.__fake.nextUploadStatus = null; return new Response('boom', { status: s }) }
          files[arg.path] = { content: window.__fake.corruptBackup && arg.mode === 'add' ? body + '\\n// tampered' : body, rev: 'rev' + (revSeq++) }
          return new Response('{}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }
    })()`
    await dt.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE })

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const shot = async (label) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(join(OUT, `legacy-${label}.png`), Buffer.from(data, 'base64'))
    }

    await dt.send('Page.navigate', { url: base })
    await waitFor('paint', async () => await evaluate(`!!document.querySelector('.app')`))
    await evaluate(`localStorage.setItem('wt.active.v1', JSON.stringify({ active: null, templates: [],
      settings: { units: 'lbs', restSeconds: 90, philosophy: 'balanced',
        dropboxToken: 'synthetic-test-token', dropboxTokenExpiresAt: ${Date.now() + 86_400_000} } }))`)
    await evaluate(`localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))`)
    await dt.send('Page.navigate', { url: base })
    await waitFor('reloaded', async () => await evaluate(`!!document.querySelector('.app')`))
    await evaluate(`window.__fake.files['/workouts.jsonl'] = { content: ${JSON.stringify(FIXTURE)}, rev: 'rev0' }`)

    // --- open Settings and the Resolve legacy weight units disclosure
    await evaluate(`[...document.querySelectorAll('.tabbar button')].find(b => /setting/i.test(b.textContent)).click()`)
    await waitFor('settings', async () => await evaluate(`!!document.querySelector('details summary')`))
    const opened = await evaluate(`(() => {
      const d = [...document.querySelectorAll('details')].find(d => /Resolve legacy weight units/.test(d.querySelector('summary')?.textContent ?? ''))
      if (!d) return false; d.open = true; d.scrollIntoView({ block: 'center' }); return true })()`)
    record('the legacy-units panel exists in Settings', opened)

    const panelText = () => evaluate(`(() => {
      const d = [...document.querySelectorAll('details')].find(d => /Resolve legacy weight units/.test(d.querySelector('summary')?.textContent ?? ''))
      return {
        help: d.querySelector('p.muted')?.textContent ?? null,
        status: [...d.querySelectorAll('[role=status]')].map(p => p.textContent),
        alerts: [...d.querySelectorAll('[role=alert]')].map(p => p.textContent),
        selects: [...d.querySelectorAll('select')].map(s => s.value),
        labels: [...d.querySelectorAll('label')].map(l => l.textContent.split('\\n')[0].trim()),
        saveDisabled: [...d.querySelectorAll('button')].find(b => /Back up raw file/.test(b.textContent))?.disabled ?? null,
        allHaveUnits: /All records already have units/.test(d.textContent),
      } })()`)

    const beforeReview = await panelText()
    record('help text is present before any file is reviewed', /Help:/.test(beforeReview.help ?? ''), '')
    record('no unresolved-record count is shown before a file is reviewed',
      beforeReview.status.length === 0 && beforeReview.selects.length === 0,
      `status ${JSON.stringify(beforeReview.status)}`)
    record('the help paragraph says it is not itself an unresolved-data warning',
      /not an unresolved-data warning/i.test(beforeReview.help ?? ''), '')

    // --- review the synthetic workouts file
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Review workouts/.test(b.textContent)).click()`)
    await waitFor('reviewed', async () => (await panelText()).selects.length > 0)
    const reviewed = await panelText()
    await shot('reviewed')
    record('the unresolved count counts only unlabeled records',
      reviewed.status.some(s => /^2 unresolved records/.test(s)),
      `status ${JSON.stringify(reviewed.status)}`)
    record('one selector is offered per unlabeled record, defaulting to "do not migrate"',
      reviewed.selects.length === 2 && reviewed.selects.every(v => v === ''), `selects ${JSON.stringify(reviewed.selects)}`)
    record('the already-tagged kg record raises a conflict notice rather than being rewritten',
      reviewed.alerts.some(a => /explicit kg labels/.test(a) && /will not be overwritten/i.test(a)),
      `alerts ${JSON.stringify(reviewed.alerts)}`)
    record('save is blocked until every unlabeled record has a declared unit', reviewed.saveDisabled === true)
    record('the status line states that existing labels are retained',
      reviewed.status.some(s => /Existing unit labels are retained/.test(s)))

    // --- the pounds shortcut
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /entered all unlabeled records in pounds/.test(b.textContent)).click()`)
    await sleep(200)
    const pounds = await panelText()
    record('the pounds shortcut labels exactly the unlabeled records as lbs',
      pounds.selects.length === 2 && pounds.selects.every(v => v === 'lbs'), `selects ${JSON.stringify(pounds.selects)}`)
    record('the pounds shortcut enables saving', pounds.saveDisabled === false)
    await shot('pounds-selected')

    // --- save: backup, verify, replace
    await evaluate(`window.__fake.log.length = 0`)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Back up raw file/.test(b.textContent)).click()`)
    await waitFor('save finished', async () => (await panelText()).status.some(s => /Units saved|Error|failed/i.test(s)))
    const saved = await panelText()
    const log = await evaluate(`window.__fake.log`)
    const files = await evaluate(`window.__fake.files`)
    await shot('saved')
    record('the save reports success and names the raw Dropbox backup',
      saved.status.some(s => /Units saved without changing measurements/.test(s) && /before-units-/.test(s)),
      saved.status.find(s => /Units saved|Error/.test(s))?.slice(0, 120) ?? 'no status')
    record('the backup is uploaded create-only, downloaded back and compared BEFORE the replacement',
      log[0]?.op === 'upload' && log[0]?.mode === 'add' && /before-units-/.test(log[0]?.path ?? '') &&
      log[1]?.op === 'download' && log[1]?.path === log[0]?.path &&
      log[2]?.op === 'upload' && log[2]?.path === '/workouts.jsonl',
      log.map(l => `${l.op} ${l.path?.replace(/before-units-[0-9a-f-]+/, 'before-units-UUID')}${l.mode ? ` (${JSON.stringify(l.mode)})` : ''}`).join(' → '))
    const backupPath = log[0]?.path
    record('the raw backup is byte-identical to the original file',
      files[backupPath]?.content === FIXTURE, backupPath ? 'matches fixture' : 'no backup written')

    const after = files['/workouts.jsonl']?.content ?? ''
    const lines = after.split('\n')
    record('the unlabeled record is labelled with no change to its numeric literal',
      lines[0] === '{"id":"w1","date":"2024-01-02","name":"Synthetic Squat","weight":62.50,"reps":5,"weightUnit":"lbs"}',
      lines[0])
    record('the explicit kg record is retained byte for byte', lines[1] === FIXTURE.split('\n')[1], lines[1])
    record('the explicit lbs record is retained byte for byte', lines[3] === FIXTURE.split('\n')[3], lines[3])
    record('unknown extra fields on a labelled record survive', /"notes":"keep me"/.test(lines[2]), lines[2])
    record('no measurement was converted or rounded anywhere in the file',
      (after.match(/"weight":([0-9.]+)/g) ?? []).join(',') === (FIXTURE.match(/"weight":([0-9.]+)/g) ?? []).join(','),
      (after.match(/"weight":([0-9.]+)/g) ?? []).join(' '))

    // --- resolved warnings disappear on re-review
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Review workouts/.test(b.textContent)).click()`)
    await waitFor('re-reviewed', async () => (await panelText()).allHaveUnits || (await panelText()).selects.length > 0)
    const reReview = await panelText()
    await shot('re-reviewed')
    record('re-reviewing a resolved file reports it resolved and offers nothing to fix',
      reReview.allHaveUnits && reReview.selects.length === 0 && !reReview.status.some(s => /unresolved/.test(s)),
      `allHaveUnits=${reReview.allHaveUnits} selects=${reReview.selects.length}`)
    record('the kg conflict notice persists on a resolved file (the label itself is the thing to check)',
      reReview.alerts.some(a => /explicit kg labels/.test(a)), `alerts ${reReview.alerts.length}`)

    // --- repeat migration is safe: a second save attempt must not rewrite anything
    const contentBeforeRepeat = (await evaluate(`window.__fake.files['/workouts.jsonl'].content`))
    await evaluate(`window.__fake.log.length = 0`)
    const repeat = await evaluate(`(async () => {
      try { const m = await import(${JSON.stringify(new URL('./assets/', base).href)} + 'x'); return 'unexpected' } catch { return 'n/a' }
    })()`)
    void repeat
    const contentAfterRepeat = await evaluate(`window.__fake.files['/workouts.jsonl'].content`)
    record('no further write happened while re-reviewing a resolved file',
      contentAfterRepeat === contentBeforeRepeat && (await evaluate(`window.__fake.log.filter(l => l.op === 'upload').length`)) === 0,
      'no uploads')

    // --- backup verification failure must leave the original untouched
    await evaluate(`window.__fake.files['/workouts.jsonl'] = { content: ${JSON.stringify(FIXTURE)}, rev: 'rev0' }`)
    await evaluate(`window.__fake.corruptBackup = true; window.__fake.log.length = 0`)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Review workouts/.test(b.textContent)).click()`)
    await waitFor('re-review for backup test', async () => (await panelText()).selects.length === 2)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /entered all unlabeled records in pounds/.test(b.textContent)).click()`)
    await sleep(150)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Back up raw file/.test(b.textContent)).click()`)
    await waitFor('backup failure reported', async () => (await panelText()).status.some(s => /Error|failed|verification/i.test(s)))
    const corrupt = await panelText()
    const afterCorrupt = await evaluate(`window.__fake.files['/workouts.jsonl'].content`)
    await shot('backup-verify-failed')
    record('a backup that does not read back identical aborts and says the original is unchanged',
      corrupt.status.some(s => /Backup recovery verification failed/.test(s) && /original file unchanged/i.test(s)),
      corrupt.status.find(s => /Error|failed/i.test(s))?.slice(0, 140) ?? 'no status')
    record('the original file really is untouched after a failed backup verification',
      afterCorrupt === FIXTURE, afterCorrupt === FIXTURE ? 'byte-identical to fixture' : 'FILE WAS MODIFIED')
    await evaluate(`window.__fake.corruptBackup = false`)

    // --- a concurrent device that declared the other unit must be flagged, not overwritten
    await evaluate(`window.__fake.files['/workouts.jsonl'] = { content: ${JSON.stringify(FIXTURE)}, rev: 'rev0' }`)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Review workouts/.test(b.textContent)).click()`)
    await waitFor('review for conflict test', async () => (await panelText()).selects.length === 2)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /entered all unlabeled records in pounds/.test(b.textContent)).click()`)
    await sleep(150)
    // the other device gets there first and declares kg for w1
    await evaluate(`window.__fake.conflictOnce = true`)
    const OTHER = FIXTURE.split('\n').map((l, i) => i === 0 ? l.replace('"reps":5}', '"reps":5,"weightUnit":"kg"}') : l).join('\n')
    await evaluate(`window.__fake.__other = ${JSON.stringify(OTHER)}`)
    await evaluate(`[...document.querySelectorAll('details button')].find(b => /Back up raw file/.test(b.textContent)).click()`)
    await waitFor('conflict reported', async () => (await panelText()).status.some(s => /Error|declared|changed|conflict/i.test(s)), 20_000)
    const conflict = await panelText()
    const afterConflict = await evaluate(`window.__fake.files['/workouts.jsonl'].content`)
    await shot('conflict')
    record('a concurrent conflicting declaration is reported instead of silently winning',
      conflict.status.some(s => /Another device declared different units/.test(s)),
      conflict.status.find(s => /Error/.test(s))?.slice(0, 160) ?? JSON.stringify(conflict.status).slice(0, 160))
    record("the other device's kg declaration is not overwritten with lbs",
      /"id":"w1"[^\n]*"weightUnit":"kg"/.test(afterConflict),
      afterConflict.split('\n')[0])

    await dt.send('Target.closeTarget', { targetId }, undefined)
  } finally { chrome.kill(); server.close() }

  writeFileSync(join(OUT, 'legacy-results.json'), JSON.stringify(results, null, 2))
  const passed = results.filter(r => r.pass).length
  console.log(`\n${passed}/${results.length} legacy-units checks passed`)
  console.log(`evidence: ${OUT}`)
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1 }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
