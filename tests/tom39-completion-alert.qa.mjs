#!/usr/bin/env node
// Regression probe for the TOM-39 acceptance failure: the board reported no noticeable ping or
// vibration when a rest ended. The old build only called `navigator.vibrate(400)`, which cannot
// make a sound and is silently ignored in several ordinary cases, so there was no way to tell a
// delivered alert from a swallowed one.
//
// This drives the real built app in headless Chromium with `navigator.vibrate` and
// `OscillatorNode.prototype.start` instrumented, and asserts the three behaviours the fix has
// to get right:
//
//   - the alert fires exactly once, when the rest actually runs out;
//   - Skip is silent, and so is every second of the countdown (no per-second buzz, TOM-68);
//   - expiry always shows the visible fallback, because neither device channel is guaranteed.
//
// Clicks are dispatched with CDP `userGesture: true`. Without it the page has no user
// activation, autoplay policy keeps the AudioContext suspended, and the chime assertions would
// be testing the harness rather than the app. The number of oscillators per chime is calibrated
// from the Settings "Test" button rather than hard-coded, so changing the chime's note count
// does not break this probe. If the harness has no working audio output at all, that is
// reported as a limitation and the vibration and toast assertions still run.
//
// All data is synthesized here; no real health data and no network.
//
//   npm run build && node tests/tom39-completion-alert.qa.mjs
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

// Counts every vibration request and every oscillator the page starts, and leaves the real
// calls in place so a build that throws still fails. Injected before any app script runs.
const PROBE = `(() => {
  const qa = { vibes: [], oscStarts: 0 }
  window.__qa = qa
  const real = navigator.vibrate ? navigator.vibrate.bind(navigator) : null
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (pattern) => {
      qa.vibes.push(pattern)
      // Headless Chromium has no vibrator, so the real call returns false. Report true: this
      // probe is asserting what the app asked for, and the app's own honesty about undelivered
      // buzzes is covered by the toast assertion.
      if (real) { try { real(pattern) } catch {} }
      return true
    },
  })
  if (typeof OscillatorNode !== 'undefined') {
    const start = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (...args) {
      qa.oscStarts++
      return start.apply(this, args)
    }
  }
})()`

const failures = []
const notes = []
function record(name, pass, detail) {
  if (!pass) failures.push(`${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
function note(text) {
  notes.push(text)
  console.log(`  note ${text}`)
}

const SEED = (restSeconds, restEndsAt) => `(() => {
  const now = Date.now()
  localStorage.setItem('wt.active.v1', JSON.stringify({
    active: {
      id: 'qa-active', date: new Date(now).toISOString().slice(0, 10), startedAt: now - 11 * 60_000,
      name: 'QA Alert Session',
      exercises: [
        { id: 'ex1', name: 'Bench Press', sets: [
          { weight: 135, reps: 8, done: false },
          { weight: 135, reps: 8, done: false },
          { weight: 135, reps: 8, done: false },
          { weight: 135, reps: 8, done: false } ] },
      ],
      ${restEndsAt == null ? '' : `restEndsAt: ${restEndsAt}, restTotal: ${restSeconds},`}
    },
    templates: [],
    settings: { units: 'lbs', restSeconds: ${restSeconds}, philosophy: 'balanced' },
  }))
  localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
})()`

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom39-alert-chrome-'))
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

    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true })
    dt.sessionId = sessionId
    await dt.send('Page.enable')
    await dt.send('Runtime.enable')
    await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await dt.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await dt.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

    const run = async (expression, userGesture = false) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture,
      })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const tap = (expression) => run(expression, true)
    const counts = () => run(`({ vibes: window.__qa.vibes.length, oscStarts: window.__qa.oscStarts })`)
    const resetCounts = () => run(`(() => { window.__qa.vibes.length = 0; window.__qa.oscStarts = 0 })()`)
    const restTime = () => run(`document.querySelector('.rest-time')?.textContent ?? null`)
    const completeSet = (row) =>
      tap(`document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-row:not(.set-labels)')[${row}].querySelector('.icon-btn').click()`)
    const openTab = (label) =>
      tap(`[...document.querySelectorAll('.tabbar button')].find(b => b.textContent.trim().endsWith(${JSON.stringify(label)})).click()`)
    const restStatusText = () => run(`document.querySelector('.rest-status')?.textContent?.trim() ?? null`)
    const storedDeadline = () => run(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt ?? null`)

    await dt.send('Page.navigate', { url: base })
    await waitFor('first paint', async () => await run(`!!document.querySelector('.app')`))
    await run(SEED(4, null))

    // --- Settings test button: the board's own way to check the alert, and this probe's
    // --- calibration for how many oscillators one chime starts.
    console.log('\n=== Settings · Rest end alert ===')
    await dt.send('Page.navigate', { url: base })
    await waitFor('tab bar', async () => await run(`!!document.querySelector('.tabbar')`))
    await tap(`[...document.querySelectorAll('.tabbar button, .tabbar a')].find(b => /settings/i.test(b.textContent)).click()`)
    const testButton = `[...document.querySelectorAll('.setting-row')].find(r => /Rest end alert/.test(r.textContent))?.querySelector('button')`
    record('Settings offers a rest-alert test button', !!(await waitFor('settings rendered',
      async () => await run(`!!(${testButton})`), 5_000).catch(() => false)), '')
    await resetCounts()
    await tap(`(${testButton}).click()`)
    await sleep(300)
    const afterTest = await counts()
    const statusLine = await run(
      `[...document.querySelectorAll('.card')].find(c => /Rest end alert/.test(c.textContent))?.querySelector('p.muted')?.textContent?.trim() ?? ''`)
    record('the test button reports what it actually delivered', /Chime|audio/i.test(statusLine) && /buzz|vibration/i.test(statusLine),
      statusLine.slice(0, 90))
    record('the test button requests a vibration', afterTest.vibes === 1, `${afterTest.vibes} call(s)`)
    record('the status line does not push Settings sideways',
      !(await run(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)), 'at 390px')

    const NOTES_PER_CHIME = afterTest.oscStarts
    if (NOTES_PER_CHIME === 0) {
      note('no audio output in this harness — chime assertions are limited to "no sound scheduled"; a real device still needs the board')
    } else {
      record('the test button plays an audible chime', NOTES_PER_CHIME >= 1, `${NOTES_PER_CHIME} oscillator(s) per chime`)
    }

    // --- Countdown, Skip, expiry.
    console.log('\n=== Log · countdown, Skip, expiry ===')
    await run(SEED(4, null))
    await dt.send('Page.navigate', { url: base })
    await waitFor('active log', async () => await run(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    // Arm audio the way the app does, through the tap that starts a rest. The reload above
    // dropped the previous document's AudioContext.
    await resetCounts()

    await completeSet(0)
    await waitFor('rest running', async () => (await restTime()) !== '—')
    await sleep(2_200) // two full ticks of a 4s rest
    const duringCountdown = await counts()
    record('no vibration during the countdown', duringCountdown.vibes === 0, `${duringCountdown.vibes} call(s) over 2 ticks`)
    record('no sound during the countdown', duringCountdown.oscStarts === 0, `${duringCountdown.oscStarts} oscillator(s)`)

    await tap(`[...document.querySelectorAll('.rest-actions button')].find(b => b.textContent.trim() === '+30s').click()`)
    await sleep(400)
    const afterAdd = await counts()
    record('+30s does not alert', afterAdd.vibes === 0 && afterAdd.oscStarts === 0,
      `${afterAdd.vibes} vibe(s), ${afterAdd.oscStarts} oscillator(s)`)

    await tap(`[...document.querySelectorAll('.rest-actions button')].find(b => b.textContent.trim() === 'Skip').click()`)
    await waitFor('rest skipped', async () => (await restTime()) === '—')
    await sleep(1_500)
    const afterSkip = await counts()
    record('Skip is silent', afterSkip.vibes === 0 && afterSkip.oscStarts === 0,
      `${afterSkip.vibes} vibe(s), ${afterSkip.oscStarts} oscillator(s)`)
    record('Skip shows no rest-done message', !/Rest done/.test(await run(`document.querySelector('.rest-status')?.textContent ?? ''`)), '')

    await completeSet(1)
    await waitFor('second rest running', async () => (await restTime()) !== '—')
    await waitFor('rest expires on its own', async () => (await restTime()) === '—', 10_000)
    const toast = await waitFor('rest-done toast', async () => await run(`document.querySelector('.rest-status')?.textContent ?? null`), 3_000)
      .catch(() => '')
    record('expiry always shows the visible fallback', /Rest done/.test(toast), JSON.stringify(toast))
    // Settle well past one tick: an alert that re-fires on every render would show up here.
    await sleep(2_500)
    const afterExpiry = await counts()
    record('expiry vibrates exactly once', afterExpiry.vibes === 1, `${afterExpiry.vibes} call(s)`)
    record('the vibration is a pattern with gaps, not one flat pulse',
      await run(`Array.isArray(window.__qa.vibes[0]) && window.__qa.vibes[0].length > 1`),
      JSON.stringify(await run(`window.__qa.vibes[0] ?? null`)))
    if (NOTES_PER_CHIME > 0) {
      record('expiry chimes exactly once', afterExpiry.oscStarts === NOTES_PER_CHIME,
        `${afterExpiry.oscStarts} oscillator(s), one chime is ${NOTES_PER_CHIME}`)
    }
    record('expiry clears the deadline without unmounting the strip',
      await run(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt == null && !!document.querySelector('.rest-timer')`), '')

    // --- The TOM-72 failure: the app stays in the foreground, but the user is looking at
    // --- another tab when the rest runs out. `app.tsx` unmounts `LogView` on navigation, so
    // --- an expiry owned by that component's interval could not fire at all — it fired on the
    // --- return to Log instead, which is the one moment the user can already see it is done.
    for (const tabName of ['History', 'Settings']) {
      console.log(`\n=== Expiry while the ${tabName} tab is visible ===`)
      await run(SEED(4, null))
      await dt.send('Page.navigate', { url: base })
      await waitFor('active log', async () => await run(`!!document.querySelector('.active-log .set-row .icon-btn')`))
      await resetCounts()

      await completeSet(0)
      await waitFor('rest running', async () => (await restTime()) !== '—')
      await openTab(tabName)
      await waitFor(`${tabName} mounted`, async () => await run(`!document.querySelector('.active-log')`))
      record(`the Log tab really is unmounted on ${tabName}`,
        (await run(`!document.querySelector('.rest-timer')`)) === true, 'no .rest-timer in the DOM')

      // Through the deadline and two seconds past it, never leaving this tab.
      const deadline = await storedDeadline()
      await waitFor('the deadline to pass', async () => Date.now() > deadline + 2_000, 12_000)
      const awayCounts = await counts()
      record(`expiry alerts while ${tabName} is visible`, awayCounts.vibes === 1, `${awayCounts.vibes} vibration(s)`)
      if (NOTES_PER_CHIME > 0) {
        record(`expiry chimes while ${tabName} is visible`, awayCounts.oscStarts === NOTES_PER_CHIME,
          `${awayCounts.oscStarts} oscillator(s), one chime is ${NOTES_PER_CHIME}`)
      }
      record(`the deadline is cleared while ${tabName} is visible`, (await storedDeadline()) === null,
        JSON.stringify(await storedDeadline()))

      await openTab('Log')
      await waitFor('back on the Log tab', async () => await run(`!!document.querySelector('.active-log')`))
      await sleep(1_500)
      const backCounts = await counts()
      record(`returning to Log does not alert again (from ${tabName})`,
        backCounts.vibes === awayCounts.vibes && backCounts.oscStarts === awayCounts.oscStarts,
        `${backCounts.vibes - awayCounts.vibes} extra vibration(s), ${backCounts.oscStarts - awayCounts.oscStarts} extra oscillator(s)`)
      record(`the rest-done line survives the trip through ${tabName}`,
        /Rest done/.test((await restStatusText()) ?? ''), JSON.stringify(await restStatusText()))
      record(`the timer is idle again after returning from ${tabName}`, (await restTime()) === '—', `shows ${await restTime()}`)

      // A fresh rest must replace the old line rather than leaving it to contradict a
      // running countdown.
      await completeSet(1)
      await waitFor('next rest running', async () => (await restTime()) !== '—')
      record(`a new rest clears the previous rest-done line (after ${tabName})`,
        !/Rest done/.test((await restStatusText()) ?? ''), JSON.stringify(await restStatusText()))
    }

    // --- A deadline that passed while the app was closed must be cleaned up in silence.
    console.log('\n=== Reopening on an expired rest ===')
    await run(SEED(90, Date.now() - 5 * 60_000))
    await dt.send('Page.navigate', { url: base })
    await waitFor('active log reloaded', async () => await run(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    await sleep(1_500)
    const afterReopen = await counts()
    record('a rest that expired while the app was closed does not alert on open',
      afterReopen.vibes === 0 && afterReopen.oscStarts === 0,
      `${afterReopen.vibes} vibe(s), ${afterReopen.oscStarts} oscillator(s)`)
    record('the stale rest is still cleared on open',
      await run(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt == null`), '')
    record('no stale rest-done message on open',
      !/Rest done/.test(await run(`document.querySelector('.rest-status')?.textContent ?? ''`)), '')

    await dt.send('Target.closeTarget', { targetId }, null)
  } finally {
    chrome.kill()
    server.close()
  }

  console.log('')
  for (const n of notes) console.log(`LIMIT  ${n}`)
  if (failures.length) {
    console.error(`FAILED (${failures.length})`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log('All completion-alert checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
