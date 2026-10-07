#!/usr/bin/env node
// Built-app regression: rest completion must fit the reserved timer row without moving
// or covering the focused editor. Synthetic data, three channel outcomes, six viewports.
// npm run build && node tests/tom73-rest-status.qa.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

    await dt.send('Page.navigate', { url: base })
    await waitFor('first paint', async () => await run(`!!document.querySelector('.app')`))
    await run(SEED(4, null))


    for (const mode of ['supported', 'buzz-only', 'unsupported']) {
      for (const [width, height] of [[360,800],[390,844],[844,390],[1280,800],[844,214],[360,400]]) {
        await dt.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width<1000})
        await run(SEED(3,null))
        await run(`(()=>{let s=JSON.parse(localStorage.getItem('wt.active.v1'));s.active.exercises[0].sets=Array.from({length:12},()=>({weight:135,reps:8,done:false}));localStorage.setItem('wt.active.v1',JSON.stringify(s))})()`)
        await dt.send('Page.navigate', {url:base})
        await waitFor('log',async()=>await run(`!!document.querySelector('.active-log .set-row .icon-btn')`))
        if (mode !== 'supported') await run(`Object.defineProperty(window,'AudioContext',{configurable:true,value:undefined});Object.defineProperty(window,'webkitAudioContext',{configurable:true,value:undefined})`)
        if (mode === 'unsupported') await run(`Object.defineProperty(navigator,'vibrate',{configurable:true,value:undefined})`)
        await completeSet(0)
        await run(`(()=>{let f=document.querySelectorAll('.set-row:not(.set-labels) input')[8];f.focus();f.scrollIntoView({block:'center'})})()`)
        const measure = () => run(`(()=>{
          const box=e=>{let r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom}};
          const status=document.querySelector('.rest-status'), range=document.createRange();range.selectNodeContents(status);
          return {status:status.textContent, timer:box(document.querySelector('.rest-timer')), editor:box(document.querySelector('.log-scroll')), focus:box(document.activeElement), statusBox:box(status), text:box(range), overflow:document.documentElement.scrollWidth>innerWidth, floating:!!document.querySelector('.toast')};
        })()`)
        const before = await measure()
        await waitFor('completion status',async()=>await run(`document.querySelector('.rest-status')?.textContent`),6000)
        const after = await measure()
        const label = `${mode} ${width}x${height}`
        record(`${label} geometry stable`, ['timer','editor','focus'].every(k=>JSON.stringify(before[k])===JSON.stringify(after[k])), JSON.stringify({before,after}))
        record(`${label} status outside editor`, after.statusBox.b <= after.editor.y && !after.floating && !after.overflow, JSON.stringify(after))
        record(`${label} full text fits timer`, after.text.y>=after.statusBox.y && after.text.b<=after.statusBox.b && after.text.w<=after.statusBox.w, JSON.stringify(after))
        record(`${label} channel feedback`, mode==='unsupported' ? /no sound or buzz/.test(after.status) : mode==='buzz-only' ? /buzz only/.test(after.status) : after.status==='Rest done 💪', after.status)
        await completeSet(1)
        await waitFor('status cleared on next rest',async()=>await run(`document.querySelector('.rest-status').textContent === ''`))
        await tap(`[...document.querySelectorAll('button')].find(b=>/Add exercise/.test(b.textContent)).click()`)
        await waitFor('modal',async()=>await run(`!!document.querySelector('.modal input')`))
        await waitFor('expiry behind modal',async()=>await run(`document.querySelector('.rest-status')?.textContent`),6000)
        record(`${label} modal above status`, await run(`(()=>{const e=document.querySelector('.modal input'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e && !document.querySelector('.toast')})()`), '')
        await tap(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Cancel').click()`)
        record(`${label} completion survives modal`, /Rest done/.test(await run(`document.querySelector('.rest-status').textContent`)), '')
      }
    }
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
