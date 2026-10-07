#!/usr/bin/env node
// TOM-66 verification probe for c602979. Covers the acceptance criteria the existing
// harnesses do not assert directly:
//
//   A. AC1 no-movement — the set editor must not shift when rest starts, extends,
//      is skipped, or expires. Measured at 360x800, 390x844, 844x390 and 1280x800.
//   B. .compact threshold — present at a <=420px box, absent above it, so portrait
//      with the keyboard up (~464px) is untouched.
//   C. Focus reveal without a resize — tapping a different field while the keyboard
//      is ALREADY open fires no visualViewport resize. Does the field still come into view?
//   D. Compact chrome — what .compact trims, whether anything clips or overflows,
//      and whether the tab bar keeps a usable tap target.
//   E. "unresolved record" pluralisation at 1 and 2.
//
// Synthetic data only. Usage: node tom66-verify.qa.mjs <dist-dir> <label>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const LABEL = process.argv[3] ?? 'candidate'
const OUT = process.env.OUT ? resolve(process.env.OUT) : mkdtempSync(join(tmpdir(), 'tom66-'))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ok   ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL ${m}`) }
const note = (m) => console.log(`  note ${m}`)
const check = (cond, m) => (cond ? ok(m) : bad(m))

async function waitFor(what, fn, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}
function builtBasePath() { return readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/' }
function serveDist() {
  const basePath = builtBasePath()
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const rel = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname.slice(1)
    const file = join(DIST, rel || 'index.html')
    const path = file.startsWith(DIST) && existsSync(file) && rel ? file : join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(readFileSync(path))
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port, basePath })))
}
class Devtools {
  constructor(socket) { this.socket = socket; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id == null) return
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result) }) }
  static async open(u) { const s = new WebSocket(u)
    await new Promise((done, no) => { s.addEventListener('open', done, { once: true }); s.addEventListener('error', () => no(new Error('ws')), { once: true }) })
    return new Devtools(s) }
  send(method, params = {}, sessionId = this.sessionId) { const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method })) }
}

const LONG_NAME = 'Seated Incline Dumbbell Press (Neutral Grip, Paused at Bottom) — Machine #4'
const VIEWPORTS = [
  { w: 360, h: 800, name: '360x800-portrait' },
  { w: 390, h: 844, name: '390x844-portrait' },
  { w: 844, h: 390, name: '844x390-landscape' },
  { w: 1280, h: 800, name: '1280x800-desktop' },
]

async function main() {
  const { server, port, basePath } = await serveDist()
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom66-chrome-'))
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
    const setViewport = (w, h) => dt.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true })
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }
    const shot = async (label) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT, `${LABEL}-${label}.png`), Buffer.from(data, 'base64'))
    }
    const seed = (restSeconds = 90) => evaluate(`(() => {
      const now = Date.now()
      localStorage.setItem('wt.active.v1', JSON.stringify({
        active: { id: 'qa-active', date: new Date(now).toISOString().slice(0,10), startedAt: now - 11*60000,
          name: 'QA Synthetic Session',
          exercises: [
            { id:'ex1', name: ${JSON.stringify(LONG_NAME)}, sets: [ {weight:135,reps:8,done:false},{weight:135,reps:8,done:false},{weight:135,reps:8,done:false} ] },
            { id:'ex2', name:'Cable Row', sets: [ {weight:90,reps:10,done:false},{weight:90,reps:10,done:false},{weight:90,reps:10,done:false} ] } ] },
        templates: [], settings: { units:'lbs', restSeconds:${restSeconds}, philosophy:'balanced' } }))
      localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] }))
    })()`)
    const boot = async (w, h, restSeconds = 90) => {
      await setViewport(w, h)
      await dt.send('Page.navigate', { url: base })
      await waitFor('paint', async () => await evaluate(`!!document.querySelector('.app')`))
      await seed(restSeconds)
      await dt.send('Page.navigate', { url: base })
      await waitFor('log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))
    }
    // geometry of the fixed bands + the set editor
    const geom = () => evaluate(`(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null
        const b = e.getBoundingClientRect(); return { top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), height:+b.height.toFixed(1), width:+b.width.toFixed(1) } }
      const app = document.querySelector('.app')
      return {
        compactClass: !!app?.classList.contains('compact'),
        loggingClass: !!app?.classList.contains('logging'),
        innerHeight: window.innerHeight,
        scroll: r('.log-scroll'), timer: r('.rest-timer'), tabbar: r('.tabbar'), header: r('.log-header'),
        restTime: document.querySelector('.rest-time')?.textContent ?? null,
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })()`)
    const restText = () => evaluate(`document.querySelector('.rest-time')?.textContent ?? null`)
    const diag = async () => JSON.stringify({
      restTime: await restText(),
      iconBtns: await evaluate(`document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-row:not(.set-labels) .icon-btn').length`),
      stored: await evaluate(`(JSON.parse(localStorage.getItem('wt.active.v1')||'{}').active||{}).restEndsAt ?? null`),
      settings: await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('wt.active.v1')||'{}').settings ?? null)`),
      firstSetDone: await evaluate(`((JSON.parse(localStorage.getItem('wt.active.v1')||'{}').active||{}).exercises?.[0]?.sets?.[0]?.done) ?? null`),
    })
    /** Click the first not-yet-done set's toggle, which is what starts rest. */
    const startRest = async () => {
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.exercise-card')[0].querySelectorAll('.set-row:not(.set-labels)')]
        const row = rows.find(r => !r.classList.contains('done')) ?? rows[0]
        row.querySelector('.icon-btn').click(); return true })()`)
      try {
        await waitFor('resting', async () => (await restText()) !== '—', 6_000)
      } catch (e) {
        console.log(`  diag at startRest timeout: ${await diag()}`)
        throw e
      }
    }

    // ---------------------------------------------------------------- A. AC1 no-movement
    console.log(`\n=== A. AC1: the set editor must not move across rest state changes ===`)
    const acRows = []
    for (const v of VIEWPORTS) {
      await boot(v.w, v.h, 3) // 3s rest so expiry is observable
      const states = {}
      states.idle = await geom()
      await startRest()
      await sleep(150)
      states.running = await geom()
      await evaluate(`[...document.querySelectorAll('.rest-timer button')].find(b=>/\\+30/.test(b.textContent))?.click()`)
      await sleep(150)
      states.extended = await geom()
      await evaluate(`[...document.querySelectorAll('.rest-timer button')].find(b=>/Skip/i.test(b.textContent))?.click()`)
      await waitFor('skipped', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—')
      await sleep(150)
      states.skipped = await geom()
      await startRest()
      await waitFor('expired', async () => (await evaluate(`document.querySelector('.rest-time')?.textContent`)) === '—', 12_000)
      await sleep(250)
      states.expired = await geom()

      const tops = Object.entries(states).map(([k, s]) => [k, s.scroll?.top])
      const heights = Object.entries(states).map(([k, s]) => [k, s.scroll?.height])
      const topSet = [...new Set(tops.map(([, t]) => t))]
      const hSet = [...new Set(heights.map(([, h]) => h))]
      check(topSet.length === 1, `${v.name}: set editor top identical in all 5 rest states (${tops.map(([k, t]) => `${k}=${t}`).join(' ')})`)
      check(hSet.length === 1, `${v.name}: set editor height identical in all 5 rest states (${heights.map(([k, h]) => `${k}=${h}`).join(' ')})`)
      const timerSet = [...new Set(Object.values(states).map((s) => s.timer?.height))]
      check(timerSet.length === 1 && timerSet[0] != null, `${v.name}: timer strip mounted at a constant height in all 5 states (${timerSet.join(',')})`)
      const ovf = Object.entries(states).filter(([, s]) => s.docOverflowX > 0)
      check(ovf.length === 0, `${v.name}: no horizontal overflow in any rest state (${ovf.map(([k, s]) => `${k}=+${s.docOverflowX}`).join(',') || 'all 0'})`)
      acRows.push({ viewport: v.name, states })
    }

    // ---------------------------------------------------------------- B. .compact threshold
    console.log(`\n=== B. .compact applies at <=420px and leaves portrait+keyboard alone ===`)
    await boot(390, 844)
    const thresholds = [844, 464, 460, 421, 420, 419, 390, 234]
    const tRows = []
    for (const h of thresholds) {
      await setViewport(390, h)
      await sleep(300)
      const g = await geom()
      tRows.push({ h, compact: g.compactClass, timer: g.timer?.height, editor: g.scroll?.height })
      const want = h <= 420
      check(g.compactClass === want, `box ${h}px: compact=${g.compactClass} (expected ${want}) timer=${g.timer?.height} editor=${g.scroll?.height}`)
    }
    const portrait464 = tRows.find((r) => r.h === 464)
    const portrait844 = tRows.find((r) => r.h === 844)
    check(portrait464 && !portrait464.compact && portrait464.timer === portrait844.timer,
      `portrait with the keyboard up (464px box) keeps the full 59px chrome, unchanged by .compact (timer ${portrait464?.timer} vs ${portrait844?.timer})`)

    // ---------------------------------------------------------------- C. focus reveal with NO resize
    console.log(`\n=== C. focusing another field while the keyboard is ALREADY open (no resize event) ===`)
    await boot(844, 390)
    // keyboard opens once: focus the FIRST input, then shrink. This is the resize path that works.
    await evaluate(`(() => { const i = document.querySelector('.set-row:not(.set-labels) .set-input'); i.focus(); return true })()`)
    await sleep(150)
    await setViewport(844, 214) // 45% keyboard
    await sleep(500)
    const afterResize = await evaluate(`(() => {
      const b = document.activeElement.getBoundingClientRect()
      return { top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), visible: b.top >= -1 && b.bottom <= window.innerHeight + 1 } })()`)
    check(afterResize.visible, `first field is revealed when the keyboard opens (resize path) input=${afterResize.top}–${afterResize.bottom}`)
    // now, with the keyboard already open and NO viewport change, focus the LAST input of the LAST exercise
    const afterFocus = await evaluate(`(() => {
      const cards = document.querySelectorAll('.exercise-card')
      const rows = cards[cards.length-1].querySelectorAll('.set-row:not(.set-labels)')
      const i = rows[rows.length-1].querySelectorAll('.set-input')[0]
      i.focus()
      const b = i.getBoundingClientRect()
      return { top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), visible: b.top >= -1 && b.bottom <= window.innerHeight + 1,
               scrollTop: document.querySelector('.log-scroll')?.scrollTop } })()`)
    await sleep(600) // give the two rAFs in revealFocusedField every chance to run
    const settled = await evaluate(`(() => {
      const b = document.activeElement.getBoundingClientRect()
      return { top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), visible: b.top >= -1 && b.bottom <= window.innerHeight + 1,
               scrollTop: document.querySelector('.log-scroll')?.scrollTop } })()`)
    await shot('focus-no-resize')
    note(`immediately on focus: input=${afterFocus.top}–${afterFocus.bottom} visible=${afterFocus.visible} scrollTop=${afterFocus.scrollTop}`)
    note(`after 600ms:          input=${settled.top}–${settled.bottom} visible=${settled.visible} scrollTop=${settled.scrollTop}`)
    check(settled.visible, `a field focused while the keyboard is already open ends up visible without a manual scroll (input=${settled.top}–${settled.bottom}, vh=${(await geom()).innerHeight})`)

    // ---------------------------------------------------------------- D. compact chrome
    console.log(`\n=== D. what .compact trims, and whether it clips ===`)
    await boot(844, 390)
    await startRest()
    await sleep(200)
    const chrome844 = await evaluate(`(() => {
      const app = document.querySelector('.app')
      const lab = document.querySelector('.rest-label')
      const btns = [...document.querySelectorAll('.tabbar button')]
      const clipped = []
      for (const e of document.querySelectorAll('.active-log *, .tabbar *')) {
        if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') clipped.push(e.className + ':w' + e.scrollWidth + '>' + e.clientWidth)
        if (e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY === 'hidden') clipped.push(e.className + ':h' + e.scrollHeight + '>' + e.clientHeight)
      }
      return {
        compact: app.classList.contains('compact'),
        restLabelDisplay: lab ? getComputedStyle(lab).display : 'absent',
        tabFontSize: btns[0] ? getComputedStyle(btns[0]).fontSize : null,
        tabIconFontSize: document.querySelector('.tabbar .tab-icon') ? getComputedStyle(document.querySelector('.tabbar .tab-icon')).fontSize : null,
        tabButtonHeights: btns.map(b => +b.getBoundingClientRect().height.toFixed(1)),
        tabbarHeight: +document.querySelector('.tabbar').getBoundingClientRect().height.toFixed(1),
        timerHeight: +document.querySelector('.rest-timer').getBoundingClientRect().height.toFixed(1),
        restTimeText: document.querySelector('.rest-time')?.textContent,
        skipEnabled: ![...document.querySelectorAll('.rest-timer button')].find(b=>/Skip/i.test(b.textContent))?.disabled,
        clipped,
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })()`)
    check(chrome844.compact, `844x390 landscape is compact`)
    check(chrome844.restLabelDisplay === 'none', `compact hides the REST caption (display=${chrome844.restLabelDisplay})`)
    check(chrome844.tabFontSize === '0px', `compact drops the tab-bar captions (font-size=${chrome844.tabFontSize}, icons still ${chrome844.tabIconFontSize})`)
    check(chrome844.clipped.length === 0, `nothing clips its own content in compact (${chrome844.clipped.join(' | ') || 'none'})`)
    check(chrome844.docOverflowX === 0, `no horizontal overflow in compact (+${chrome844.docOverflowX})`)
    check(chrome844.restTimeText && chrome844.restTimeText !== '—', `the countdown itself is still readable in compact ("${chrome844.restTimeText}")`)
    check(chrome844.skipEnabled, `Skip is still live in compact`)
    const minTap = Math.min(...chrome844.tabButtonHeights)
    note(`compact tab-bar: height=${chrome844.tabbarHeight}px, button tap target min=${minTap}px (24px is the WCAG 2.2 AA minimum, 44px the comfortable one)`)
    check(minTap >= 24, `compact tab-bar buttons keep at least a 24px tap target (${minTap}px)`)
    await shot('compact-landscape-resting')

    // ---------------------------------------------------------------- E. pluralisation
    console.log(`\n=== E. "unresolved record" pluralisation ===`)
    const js = readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="([^"]*assets\/index-[^"]*)"/)?.[1]
    const bundle = readFileSync(join(DIST, js.replace(basePath, '').replace(/^\//, '')), 'utf8')
    const hasPlural = /unresolved record/.test(bundle)
    check(hasPlural, `the pluralised string is in the shipped bundle`)
    const m = bundle.match(/.{70}unresolved record.{60}/)
    note(`shipped: ${m ? m[0].replace(/\s+/g, ' ') : 'pattern not found'}`)
    // the minifier emits template literals, so accept either quote style
    const flat = bundle.replace(/\s/g, '')
    check(/===?1\?(""|``|'')\?*:(?:"s"|`s`|'s')/.test(flat), `the singular/plural branch survived minification`)

    writeFileSync(join(OUT, `${LABEL}-tom66.json`), JSON.stringify({ acRows, thresholds: tRows, afterResize, afterFocus, settled, chrome844 }, null, 2))
    console.log(`\n${pass}/${pass + fail} TOM-66 checks passed`)
    console.log(`evidence: ${OUT}`)
    if (fail) process.exitCode = 1
  } finally { chrome.kill(); server.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
