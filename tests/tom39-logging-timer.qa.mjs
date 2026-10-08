#!/usr/bin/env node
// Browser evidence for the rest-timer half of TOM-39 / TOM-59.
//
// The engineering checks cover migration, sync and codec arithmetic. They say nothing about
// whether the reserved-space timer actually fits a phone, so this drives the real built app in
// headless Chromium and measures geometry instead of trusting the CSS.
//
// For each viewport it starts a synthetic multi-exercise workout (one exercise carries a
// deliberately long name), completes a set to arm the timer, then asserts:
//   - the timer occupies its own box: it never overlaps the scrolling set editor or the tabbar
//   - completing a set leaves the set inputs reachable (no overlay covering a focused field)
//   - the document never grows a horizontal scrollbar
//   - collapse/expand and +30s work, and +30s extends the deadline rather than resetting it
//   - the countdown deadline survives a tab switch away and back
//   - a shrunken viewport (on-screen keyboard) keeps a focused weight input fully visible
//
// All data is synthesized here; the run touches no real health data and no network.
//
//   npm run build && node tests/tom39-logging-timer.qa.mjs [--out <dir>]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom39-timer-evidence-'))

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

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

function builtBasePath() {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  return html.match(/src="(.*?)assets\/index-/)?.[1] ?? '/'
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

// A phone-sized portrait, a narrower phone, the same phone in landscape, and a desktop.
const VIEWPORTS = [
  { name: '360x800-portrait', width: 360, height: 800, mobile: true },
  { name: '390x844-portrait', width: 390, height: 844, mobile: true },
  { name: '844x390-landscape', width: 844, height: 390, mobile: true },
  { name: '1280x800-desktop', width: 1280, height: 800, mobile: false },
]

// One long name on purpose: the set editor and the timer share a column, so an unwrapped
// exercise title is the most likely source of horizontal overflow.
const LONG_NAME = 'Seated Incline Dumbbell Press (Neutral Grip, Paused at Bottom) — Machine #4'

const results = []
const failures = []

function record(viewport, name, pass, detail) {
  results.push({ viewport, name, pass, detail })
  if (!pass) failures.push(`[${viewport}] ${name}: ${detail}`)
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : detail ? ` (${detail})` : ''}`)
}

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom39-timer-chrome-'))
  const chrome = spawn(
    process.env.CHROME ?? 'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
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
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
      dt.sessionId = sessionId
      await dt.send('Page.enable')
      await dt.send('Runtime.enable')
      await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })

      const setViewport = (width, height) =>
        dt.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: vp.mobile })
      await setViewport(vp.width, vp.height)

      const evaluate = async (expression) => {
        const { result, exceptionDetails } = await dt.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
        return result.value
      }
      const shot = async (label) => {
        const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
        const file = join(OUT, `${vp.name}-${label}.png`)
        writeFileSync(file, Buffer.from(data, 'base64'))
        return file
      }

      // Seed a synthetic in-progress workout straight into the store's own keys, then load the
      // app so it boots into the Log view with a live workout.
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
              { id: 'ex3', name: 'Lateral Raise', sets: [ { weight: 20, reps: 15, done: false }, { weight: 20, reps: 15, done: false } ] },
            ],
          },
          templates: [],
          settings: { units: 'lbs', restSeconds: 90, philosophy: 'balanced' },
        }))
        localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
      })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('active log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))

      record(vp.name, 'multi-exercise workout renders in the log view',
        await evaluate(`document.querySelectorAll('.exercise-card').length`) === 3,
        `${await evaluate(`document.querySelectorAll('.exercise-card').length`)} exercise cards`)

      // --- arm the timer by completing the first set of the first exercise
      await evaluate(`document.querySelectorAll('.exercise-card')[0].querySelector('.set-row:not(.set-labels) .icon-btn').click()`)
      await waitFor('rest timer', async () => await evaluate(`!!document.querySelector('.rest-timer')`))
      await shot('timer-collapsed')

      const geom = () => evaluate(`(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height } }
        return {
          timer: r(document.querySelector('.rest-timer')),
          scroll: r(document.querySelector('.log-scroll')),
          tabbar: r(document.querySelector('.tabbar')),
          header: r(document.querySelector('.log-header')),
          docScrollWidth: document.documentElement.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
          innerHeight: window.innerHeight,
          time: document.querySelector('.rest-time')?.textContent ?? null,
        }
      })()`)

      let g = await geom()

      record(vp.name, 'no horizontal overflow with the timer up and a long exercise name',
        g.docScrollWidth <= g.docClientWidth,
        `scrollWidth ${g.docScrollWidth} vs clientWidth ${g.docClientWidth}`)

      record(vp.name, 'timer does not overlap the scrolling set editor',
        g.timer && g.scroll && g.timer.bottom <= g.scroll.top + 1,
        `timer.bottom ${g.timer?.bottom?.toFixed(1)} vs scroll.top ${g.scroll?.top?.toFixed(1)}`)

      record(vp.name, 'timer does not overlap the tab bar',
        g.timer && g.tabbar && g.timer.bottom <= g.tabbar.top + 1,
        `timer.bottom ${g.timer?.bottom?.toFixed(1)} vs tabbar.top ${g.tabbar?.top?.toFixed(1)}`)

      record(vp.name, 'tab bar stays inside the viewport while logging',
        g.tabbar && g.tabbar.bottom <= g.innerHeight + 1,
        `tabbar.bottom ${g.tabbar?.bottom?.toFixed(1)} vs innerHeight ${g.innerHeight}`)

      record(vp.name, 'collapsed timer is a compact strip, not a half-screen panel',
        g.timer && g.timer.height <= g.innerHeight * 0.25,
        `timer height ${g.timer?.height?.toFixed(1)} of ${g.innerHeight}`)

      // --- collapse / expand
      const toggleLabel = () => evaluate(`document.querySelector('.rest-summary button')?.textContent ?? null`)
      record(vp.name, 'controls start collapsed behind a Show controls button',
        (await toggleLabel()) === 'Show controls', `label "${await toggleLabel()}"`)

      await evaluate(`document.querySelector('.rest-summary button').click()`)
      await waitFor('expanded controls', async () => await evaluate(`!!document.querySelector('.rest-actions')`))
      await shot('timer-expanded')
      const gExpanded = await geom()
      record(vp.name, 'expanded controls still do not overlap the set editor',
        gExpanded.timer.bottom <= gExpanded.scroll.top + 1,
        `timer.bottom ${gExpanded.timer.bottom.toFixed(1)} vs scroll.top ${gExpanded.scroll.top.toFixed(1)}`)
      record(vp.name, 'expanded timer does not grow a horizontal scrollbar',
        gExpanded.docScrollWidth <= gExpanded.docClientWidth,
        `scrollWidth ${gExpanded.docScrollWidth} vs clientWidth ${gExpanded.docClientWidth}`)
      record(vp.name, '+30s and Skip buttons are both present and on one row',
        await evaluate(`(() => {
          const b = [...document.querySelectorAll('.rest-actions button')]
          if (b.length !== 2) return false
          const tops = b.map(x => Math.round(x.getBoundingClientRect().top))
          return tops[0] === tops[1] && b.map(x => x.textContent.trim()).join('|') === '+30s|Skip'
        })()`),
        await evaluate(`[...document.querySelectorAll('.rest-actions button')].map(b=>b.textContent.trim()).join(', ')`))

      // --- +30s must extend the existing deadline, not restart it
      const before = await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt`)
      await evaluate(`[...document.querySelectorAll('.rest-actions button')].find(b => b.textContent.trim() === '+30s').click()`)
      await sleep(250)
      const after = await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt`)
      record(vp.name, '+30s extends the deadline by exactly 30s',
        after - before === 30_000, `delta ${(after - before) / 1000}s`)

      // --- deadline survives leaving the Log tab and coming back
      await evaluate(`[...document.querySelectorAll('.tabbar button')].find(b => /histor/i.test(b.textContent)).click()`)
      await waitFor('left the log view', async () => await evaluate(`!document.querySelector('.active-log')`))
      await sleep(1200)
      await evaluate(`[...document.querySelectorAll('.tabbar button')].find(b => /log/i.test(b.textContent)).click()`)
      await waitFor('back in the log view', async () => await evaluate(`!!document.querySelector('.active-log')`))
      const afterReturn = await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt`)
      record(vp.name, 'countdown keeps its deadline across a tab switch',
        afterReturn === after, `restEndsAt ${afterReturn === after ? 'unchanged' : `moved ${(afterReturn - after) / 1000}s`}`)
      record(vp.name, 'timer is still counting down after returning to the log view',
        await evaluate(`!!document.querySelector('.rest-timer')`) &&
          /^[0-9]+:[0-9]{2}$/.test(await evaluate(`document.querySelector('.rest-time').textContent`)),
        `shows ${await evaluate(`document.querySelector('.rest-time')?.textContent ?? 'nothing'`)}`)

      // --- a full page reload is the Android process-restart analogue
      await dt.send('Page.navigate', { url: base })
      await waitFor('reloaded log view', async () => await evaluate(`!!document.querySelector('.active-log')`))
      const afterReload = await evaluate(`document.querySelector('.rest-time')?.textContent ?? null`)
      record(vp.name, 'timer survives a reload with a shrinking countdown',
        afterReload != null && /^[0-9]+:[0-9]{2}$/.test(afterReload), `shows ${afterReload}`)

      // --- shrink the viewport the way an on-screen keyboard does, with a weight input focused
      if (vp.mobile) {
        const keyboardHeight = Math.round(vp.height * 0.45)
        await evaluate(`(() => {
          const i = document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-input')[0]
          i.scrollIntoView({ block: 'center' }); i.focus(); return true
        })()`)
        await setViewport(vp.width, vp.height - keyboardHeight)
        await sleep(600)
        await shot('timer-keyboard-open')
        const k = await evaluate(`(() => {
          const el = document.activeElement
          const b = el.getBoundingClientRect()
          const t = document.querySelector('.rest-timer')?.getBoundingClientRect() ?? null
          const bar = document.querySelector('.tabbar')?.getBoundingClientRect() ?? null
          const covered = (r) => r && b.top < r.bottom && b.bottom > r.top && b.left < r.right && b.right > r.left
          return {
            focusedIsSetInput: el.classList.contains('set-input'),
            visible: b.top >= -1 && b.bottom <= window.innerHeight + 1,
            coveredByTimer: covered(t), coveredByTabbar: covered(bar),
            scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
            rect: { top: b.top, bottom: b.bottom }, innerHeight: window.innerHeight,
          }
        })()`)
        record(vp.name, 'focused weight input stays fully visible with the keyboard open',
          k.focusedIsSetInput && k.visible,
          `input ${k.rect.top.toFixed(1)}–${k.rect.bottom.toFixed(1)} in 0–${k.innerHeight}`)
        record(vp.name, 'timer never covers the focused weight input',
          !k.coveredByTimer, k.coveredByTimer ? 'timer rect intersects the focused input' : 'no intersection')
        record(vp.name, 'tab bar never covers the focused weight input',
          !k.coveredByTabbar, k.coveredByTabbar ? 'tabbar rect intersects the focused input' : 'no intersection')
        record(vp.name, 'no horizontal overflow with the keyboard open',
          k.scrollWidth <= k.clientWidth, `scrollWidth ${k.scrollWidth} vs clientWidth ${k.clientWidth}`)
        await setViewport(vp.width, vp.height)
        await sleep(300)
      }

      // --- backfill an earlier set while the timer is up (scroll + edit under the timer)
      await evaluate(`(() => {
        const rows = document.querySelectorAll('.exercise-card')[2].querySelectorAll('.set-row:not(.set-labels)')
        const i = rows[0].querySelectorAll('.set-input')[0]
        i.scrollIntoView({ block: 'center' }); i.focus()
        i.value = '25'; i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(300)
      const backfilled = await evaluate(`JSON.parse(localStorage.getItem('wt.active.v1')).active.exercises[2].sets[0].weight`)
      record(vp.name, 'can backfill a set further down the list while the timer runs',
        backfilled === 25, `stored weight ${backfilled}`)
      const gBackfill = await geom()
      record(vp.name, 'timer stays put while the set editor scrolls under it',
        Math.abs(gBackfill.timer.top - gExpanded.timer.top) < 2 && gBackfill.timer.bottom <= gBackfill.scroll.top + 1,
        `timer.top ${gBackfill.timer.top.toFixed(1)}`)
      await shot('timer-after-backfill')

      // --- the rest-complete state the component implements
      await evaluate(`(() => {
        const s = JSON.parse(localStorage.getItem('wt.active.v1'))
        s.active.restEndsAt = Date.now() + 1500
        localStorage.setItem('wt.active.v1', JSON.stringify(s))
        return true
      })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('log view for expiry watch', async () => await evaluate(`!!document.querySelector('.active-log')`))
      await sleep(3500)
      const atZero = await evaluate(`(() => ({
        timerPresent: !!document.querySelector('.rest-timer'),
        doneClass: !!document.querySelector('.rest-timer.done'),
        label: document.querySelector('.rest-label')?.textContent ?? null,
        restEndsAt: JSON.parse(localStorage.getItem('wt.active.v1')).active.restEndsAt ?? null,
        restTotal: JSON.parse(localStorage.getItem('wt.active.v1')).active.restTotal ?? null,
      }))()`)
      record(vp.name, 'expired timer clears its deadline from the store',
        atZero.restEndsAt == null, `restEndsAt ${atZero.restEndsAt}`)
      results.push({
        viewport: vp.name, name: 'OBSERVATION: rest-complete state at 0:00', pass: null,
        detail: `timer present: ${atZero.timerPresent}; .done class: ${atZero.doneClass}; label: ${atZero.label}; leftover restTotal: ${atZero.restTotal}`,
      })
      console.log(`  note rest-complete state at 0:00 — present=${atZero.timerPresent} done=${atZero.doneClass} label=${atZero.label} leftoverRestTotal=${atZero.restTotal}`)
      await shot('after-timer-expiry')

      // --- finish feedback
      await evaluate(`[...document.querySelectorAll('.log-header button')].find(b => /finish/i.test(b.textContent)).click()`)
      await sleep(800)
      const finish = await evaluate(`(() => ({
        leftActiveLog: !document.querySelector('.active-log'),
        toast: document.querySelector('.toast')?.textContent ?? null,
        workouts: JSON.parse(localStorage.getItem('wt.history.v1')).workouts.length,
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        toastFits: (() => {
          const t = document.querySelector('.toast'); if (!t) return null
          const b = t.getBoundingClientRect()
          return b.left >= -1 && b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1
        })(),
      }))()`)
      await shot('after-finish')
      record(vp.name, 'finishing the workout saves it and leaves the active log',
        finish.leftActiveLog && finish.workouts === 1,
        `workouts stored ${finish.workouts}, toast "${finish.toast}"`)
      record(vp.name, 'finish feedback fits the viewport',
        finish.toast == null || finish.toastFits !== false,
        finish.toast == null ? 'no toast rendered' : `toast "${finish.toast}" within bounds: ${finish.toastFits}`)
      record(vp.name, 'no horizontal overflow after finishing',
        finish.scrollWidth <= finish.clientWidth,
        `scrollWidth ${finish.scrollWidth} vs clientWidth ${finish.clientWidth}`)

      await dt.send('Target.closeTarget', { targetId }, undefined)
      dt.sessionId = undefined
    }
  } finally {
    chrome.kill()
    server.close()
  }

  const checks = results.filter((r) => r.pass !== null)
  const passed = checks.filter((r) => r.pass).length
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`\n${passed}/${checks.length} checks passed`)
  console.log(`evidence: ${OUT}`)
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
