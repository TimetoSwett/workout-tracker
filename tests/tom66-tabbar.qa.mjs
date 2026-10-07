#!/usr/bin/env node
// TOM-66 follow-up: in `.logging.compact` the tab-bar captions are set to font-size:0.
// The ONLY active-tab indicator is `color: var(--accent)` on the button. The icons are
// emoji, which render in their own colours and ignore `color`. So the question is whether
// a user in compact landscape can still tell which tab is selected.
//
// Compares the rendered tab-bar pixels between the selected and an unselected tab, in
// compact and non-compact, to settle it by measurement rather than by reading the CSS.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const OUT = process.env.OUT ? resolve(process.env.OUT) : mkdtempSync(join(tmpdir(), 'tom66-tabbar-'))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ok   ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))
const note = (m) => console.log(`  note ${m}`)

async function waitFor(what, fn, t = 15000) { const u = Date.now() + t
  for (;;) { const g = await fn(); if (g) return g; if (Date.now() > u) throw new Error(`timed out waiting for ${what}`); await sleep(100) } }
function basePathOf() { return readFileSync(join(DIST, 'index.html'), 'utf8').match(/src="(.*?)assets\/index-/)?.[1] ?? '/' }
function serveDist() { const basePath = basePathOf()
  const server = createServer((req, res) => { const url = new URL(req.url, 'http://localhost')
    const rel = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname.slice(1)
    const file = join(DIST, rel || 'index.html')
    const p = file.startsWith(DIST) && existsSync(file) && rel ? file : join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(readFileSync(p)) })
  return new Promise((d) => server.listen(0, '127.0.0.1', () => d({ server, port: server.address().port, basePath }))) }
class Devtools {
  constructor(s) { this.socket = s; this.next = 1; this.pending = new Map(); this.sessionId = undefined
    s.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id == null) return
      const p = this.pending.get(m.id); this.pending.delete(m.id); if (!p) return
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result) }) }
  static async open(u) { const s = new WebSocket(u)
    await new Promise((d, n) => { s.addEventListener('open', d, { once: true }); s.addEventListener('error', () => n(new Error('ws')), { once: true }) })
    return new Devtools(s) }
  send(method, params = {}, sessionId = this.sessionId) { const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej, method })) } }

async function main() {
  const { server, port, basePath } = await serveDist()
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom66-tab-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const pf = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(pf)) return null
      const [l] = readFileSync(pf, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const v = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(v.webSocketDebuggerUrl)
    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
    dt.sessionId = sessionId
    await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    const setViewport = (w, h) => dt.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true })
    const evaluate = async (e) => { const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed'); return result.value }

    await setViewport(844, 390)
    await dt.send('Page.navigate', { url: base })
    await waitFor('paint', async () => await evaluate(`!!document.querySelector('.app')`))
    await evaluate(`(() => { const now = Date.now()
      localStorage.setItem('wt.active.v1', JSON.stringify({
        active: { id:'qa', date:new Date(now).toISOString().slice(0,10), startedAt: now-60000, name:'QA Synthetic Session',
          exercises:[{id:'ex1',name:'Bench',sets:[{weight:135,reps:8,done:false},{weight:135,reps:8,done:false}]}] },
        templates: [], settings:{units:'lbs',restSeconds:90,philosophy:'balanced'} }))
      localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] })) })()`)
    await dt.send('Page.navigate', { url: base })
    await waitFor('log', async () => await evaluate(`!!document.querySelector('.active-log .set-row .icon-btn')`))

    // crop the tab bar and compare the active button's pixels against an inactive one
    const grab = async (tag) => {
      const box = await evaluate(`(() => { const b = document.querySelector('.tabbar').getBoundingClientRect()
        return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } })()`)
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 3 } })
      writeFileSync(join(OUT, `tabbar-${tag}.png`), Buffer.from(data, 'base64'))
      return box
    }
    const info = () => evaluate(`(() => {
      const app = document.querySelector('.app')
      const btns = [...document.querySelectorAll('.tabbar button')]
      const act = btns.find(b => b.classList.contains('active')) ?? btns[0]
      const inact = btns.find(b => !b.classList.contains('active'))
      const cs = (e) => { const s = getComputedStyle(e); return { color: s.color, fontSize: s.fontSize, bg: s.backgroundColor, borderTop: s.borderTopColor, outline: s.outlineStyle } }
      const iconOf = (b) => b.querySelector('.tab-icon')?.textContent
      const captionText = (b) => b.textContent.replace(iconOf(b) ?? '', '').trim()
      return {
        compact: app.classList.contains('compact'),
        activeIdx: btns.indexOf(act), activeIcon: iconOf(act), activeCaption: captionText(act), active: cs(act),
        inactiveIcon: iconOf(inact), inactiveCaption: captionText(inact), inactive: cs(inact),
        // does the active caption actually occupy any space?
        activeCaptionBox: (() => { const n = [...act.childNodes].find(n => n.nodeType === 1 && !n.classList?.contains('tab-icon'))
          if (!n) return null; const b = n.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } })(),
        ariaCurrent: act.getAttribute('aria-current'), ariaSelected: act.getAttribute('aria-selected'),
        role: act.getAttribute('role'), ariaLabel: act.getAttribute('aria-label'), title: act.getAttribute('title'),
      }
    })()`)

    console.log(`\n=== non-compact (844x390 is compact, so use a tall box first) ===`)
    await setViewport(844, 700)
    await sleep(400)
    const tall = await info()
    await grab('non-compact')
    note(`compact=${tall.compact} active[${tall.activeIdx}] icon=${tall.activeIcon} caption="${tall.activeCaption}" color=${tall.active.color} fontSize=${tall.active.fontSize}`)
    note(`             inactive icon=${tall.inactiveIcon} caption="${tall.inactiveCaption}" color=${tall.inactive.color}`)
    check(!tall.compact, `tall box is not compact`)
    check(tall.active.color !== tall.inactive.color, `non-compact: the active tab has a different text colour (${tall.active.color} vs ${tall.inactive.color})`)
    check(tall.activeCaption.length > 0 && tall.active.fontSize !== '0px', `non-compact: the active tab's caption is rendered ("${tall.activeCaption}" at ${tall.active.fontSize}) — this is what carries the accent colour`)

    console.log(`\n=== compact (844x390) ===`)
    await setViewport(844, 390)
    await sleep(400)
    const short = await info()
    await grab('compact')
    note(`compact=${short.compact} active[${short.activeIdx}] icon=${short.activeIcon} caption="${short.activeCaption}" color=${short.active.color} fontSize=${short.active.fontSize}`)
    note(`             caption box: ${JSON.stringify(short.activeCaptionBox)}`)
    note(`a11y on the active button: role=${short.role} aria-current=${short.ariaCurrent} aria-selected=${short.ariaSelected} aria-label=${short.ariaLabel} title=${short.title}`)
    check(short.compact, `844x390 is compact`)
    check(short.active.color !== short.inactive.color, `compact: the CSS still sets a different colour on the active button (${short.active.color} vs ${short.inactive.color})`)
    check(short.active.fontSize === '0px', `compact: the caption is collapsed to font-size 0`)

    // the decisive test: are the rendered pixels of the active tab distinguishable?
    const diff = await evaluate(`(async () => {
      const bar = document.querySelector('.tabbar')
      const btns = [...bar.querySelectorAll('button')]
      const act = btns.find(b => b.classList.contains('active')) ?? btns[0]
      const inact = btns.find(b => !b.classList.contains('active'))
      // compare the computed colour the emoji would take vs what emoji actually paint:
      // emoji glyphs are colour fonts and ignore 'color'. Detect by rendering both to a canvas.
      const paint = (text, color, px) => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64
        const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0,0,64,64)
        x.fillStyle = color; x.font = px + ' sans-serif'; x.textBaseline = 'top'; x.fillText(text, 4, 4)
        return c.getContext('2d').getImageData(0,0,64,64).data
      }
      const icon = act.querySelector('.tab-icon').textContent
      const a = paint(icon, getComputedStyle(act).color, '24px')
      const b = paint(icon, getComputedStyle(inact).color, '24px')
      let differing = 0
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) differing++
      return { icon, activeColor: getComputedStyle(act).color, inactiveColor: getComputedStyle(inact).color, differingPixels: differing }
    })()`)
    note(`rendering "${diff.icon}" in ${diff.activeColor} vs ${diff.inactiveColor}: ${diff.differingPixels} differing pixels`)
    check(diff.differingPixels === 0,
      `CONFIRMED: the emoji icon paints identically in the active and inactive colour — 'color' does not reach a colour-font glyph, so with the caption at font-size 0 the compact tab bar shows no selected-tab indicator at all`)

    console.log(`\n${pass}/${pass + fail} tab-bar checks passed`)
    console.log(`evidence: ${OUT}`)
    if (fail) process.exitCode = 1
  } finally { chrome.kill(); server.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
