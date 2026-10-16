#!/usr/bin/env node
// Regression probe for TOM-68: a rest must buzz once, at its end, and never per tick.
//
// RestTimer used to call navigator.vibrate(1) in an effect keyed on secondsLeft, so a default
// 90-second rest asked the motor to fire 90 times before the one pulse that meant something.
// The board confirmed they want nothing each second. Headless Chromium has no vibration motor,
// so the only way to see this is to instrument navigator.vibrate itself — which is what this
// does, before any app script runs, recording every call with its argument and timestamp.
//
// Asserted over a 3-second rest driven to natural expiry: exactly one vibrate call, at the
// end, carrying a buzz you could actually feel. The old code recorded [1, 1, 1, 400].
//
// This deliberately does NOT pin the completion buzz to one literal argument. It used to
// assert `=== 400`, which turned into a false FAIL the moment TOM-72 replaced the flat
// 400ms buzz with the patterned [120, 70, 120, 70, 360] — the probe reported a defect on a
// build that was behaving exactly as the board asked. What the board actually requires is
// "nothing each second, and something noticeable at the end", so that is what is asserted:
// no 1ms tick, and >= MIN_FELT_MS of motor-on time however the pattern is shaped. A future
// pattern tweak stays green; a buzz that goes away or gets imperceptible still fails.
//
// All data is synthesized here; no real health data and no network.
//
//   npm run build && node tests/tom68-rest-haptics.qa.mjs
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

// Installed before any app script on every document in the target, so it survives the reloads
// this probe does. `navigator.vibrate` is absent in headless Chromium, so it is also defined
// here: the app guards on `'vibrate' in navigator`, and without this the whole code path under
// test would be skipped and the probe would pass vacuously.
const INSTRUMENT = `(() => {
  const calls = []
  const real = navigator.vibrate
  const record = function (pattern) {
    calls.push({ pattern, at: Date.now() })
    return real ? real.call(navigator, pattern) : true
  }
  Object.defineProperty(navigator, 'vibrate', { value: record, configurable: true, writable: true })
  window.__vibrateCalls = calls
})()`

// Floor for "you can feel it". The flat 400ms buzz and TOM-72's [120, 70, 120, 70, 360]
// (600ms on) both clear this; a lone 1ms tick does not. Kept well under 600 so the pattern
// can be retuned without editing this probe.
const MIN_FELT_MS = 300

/** Motor-on milliseconds in a vibrate() argument. A pattern alternates on/off starting with
 *  on, so the even indices are the only ones the hand feels. */
function motorOnMs(arg) {
  if (typeof arg === 'number') return arg
  if (!Array.isArray(arg)) return 0
  return arg.reduce((sum, ms, i) => (i % 2 === 0 ? sum + Number(ms || 0) : sum), 0)
}

/** The regression this probe exists for: the countdown asking the motor for a 1ms tick. */
function isPerTick(arg) {
  return arg === 1 || (Array.isArray(arg) && arg.length === 1 && arg[0] === 1)
}

const failures = []
function record(name, pass, detail) {
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom68-haptics-chrome-'))
  const chrome = spawn(
    process.env.CHROME ?? 'chromium',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  let calls = []
  let restSeconds = 3
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const devtoolsPort = await waitFor('chromium devtools', () => {
      if (!existsSync(portFile)) return null
      const [line] = readFileSync(portFile, 'utf8').split('\n')
      return line && /^\d+$/.test(line) ? line : null
    })
    const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    dt.sessionId = undefined
    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true })
    dt.sessionId = sessionId
    await dt.send('Page.enable')
    await dt.send('Runtime.enable')
    await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await dt.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await dt.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })

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
            { id: 'ex1', name: 'Bench Press', sets: [
              { weight: 135, reps: 8, done: false }, { weight: 135, reps: 8, done: false } ] },
          ],
        },
        templates: [],
        settings: { units: 'lbs', restSeconds: ${restSeconds}, philosophy: 'balanced' },
      }))
      localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
    })()`)

    // Reload so the app boots against that state with a fresh call log, then let one rest run
    // all the way to natural expiry — the only point at which a buzz is wanted.
    await dt.send('Page.navigate', { url: base })
    await waitFor('active log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    record('vibrate is instrumented and visible to the app',
      await evaluate(`'vibrate' in navigator && Array.isArray(window.__vibrateCalls)`), '')
    record('nothing buzzes before a rest starts', (await evaluate(`window.__vibrateCalls.length`)) === 0, '')

    await evaluate(`document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-row:not(.set-labels)')[0].querySelector('.icon-btn').click()`)
    await waitFor('rest running', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) !== '—')
    await waitFor('rest expires on its own',
      async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—', 15_000)
    // The completion buzz fires in the same effect that clears restEndsAt, one render after the
    // DOM shows `—`. Poll for the clear rather than reading the log immediately, so a slow
    // frame cannot make this look like a build that never buzzes.
    await waitFor('expiry effect committed',
      async () => await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt == null`), 5_000)
    await sleep(300)
    calls = await evaluate(`window.__vibrateCalls.map((c) => c.pattern)`)

    await dt.send('Target.closeTarget', { targetId }, null)
  } finally {
    chrome.kill()
    server.close()
  }

  const pattern = JSON.stringify(calls)
  record(`a ${restSeconds}s rest buzzes exactly once`, calls.length === 1, `recorded ${pattern}`)
  record(`the one buzz is felt for >= ${MIN_FELT_MS}ms of motor-on time`,
    calls.length === 1 && motorOnMs(calls[0]) >= MIN_FELT_MS,
    `recorded ${pattern}, ${calls.length === 1 ? `${motorOnMs(calls[0])}ms on` : 'no single call'}`)
  record('no per-tick 1ms pulses', !calls.some(isPerTick),
    `${calls.filter(isPerTick).length} of ${calls.length} calls were a 1ms tick`)

  console.log('')
  if (failures.length) {
    console.error(`FAILED (${failures.length})`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log('All rest-haptics checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
