#!/usr/bin/env node
// TOM-69: the compact tab bar had no selected-tab indicator. The accent `color` on the active
// button only reached its caption, and `.logging.compact` zeroes the caption to buy vertical
// space — and the icons are emoji, colour-font glyphs that ignore `color` outright.
//
// This measures the fix the way TOM-66 measured the defect: it screenshots the tab bar with
// each tab selected in turn and diffs the pixels inside that tab's own column against a frame
// where a different tab is selected. If selecting a tab changes nothing in its own column,
// there is no indicator. It also checks the indicator costs no vertical space (the tab bar and
// the tap targets must not grow) and that exactly the selected button carries `aria-current`.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'tom69-'))
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
let fail = 0
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const note = (s) => console.log(`note ${s}`)

// 844x390 is the landscape phone from the ticket: <=420px tall, so `.logging.compact` applies.
// 390x844 is the same workout in portrait, where the captions are still on screen — the fix has
// to hold there too, since that is the posture the board actually uses most.
const CASES = [
  { name: 'compact', width: 844, height: 390, compact: true },
  { name: 'portrait', width: 390, height: 844, compact: false },
]
const MIN_DIFF_PX = 20

async function main() {
  const basePath = basePathOf()
  const { server, port } = await serveDist(basePath)
  const base = `http://127.0.0.1:${port}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'tom69-chrome-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const portFile = join(profile, 'DevToolsActivePort')
    const dtPort = await waitFor('devtools', () => { if (!existsSync(portFile)) return null; const [l] = readFileSync(portFile, 'utf8').split('\n'); return l && /^\d+$/.test(l) ? l : null })
    const version = await (await fetch(`http://127.0.0.1:${dtPort}/json/version`)).json()
    const dt = await Devtools.open(version.webSocketDebuggerUrl)

    for (const c of CASES) {
      const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
      const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
      dt.sessionId = sessionId
      await dt.send('Page.enable'); await dt.send('Runtime.enable'); await dt.send('Network.enable')
      await dt.send('Network.setBypassServiceWorker', { bypass: true })
      await dt.send('Emulation.setDeviceMetricsOverride', { width: c.width, height: c.height, deviceScaleFactor: 1, mobile: true })
      const ev = async (expression) => {
        const { result, exceptionDetails } = await dt.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
        return result.value
      }
      await dt.send('Page.navigate', { url: base })
      await waitFor('paint', async () => await ev(`!!document.querySelector('.app')`))
      // A workout must be active for `.logging` (and therefore `.compact`) to apply at all.
      await ev(`(() => { const now = Date.now()
        localStorage.setItem('wt.active.v1', JSON.stringify({ active: { id: 'p', date: new Date(now).toISOString().slice(0,10), startedAt: now - 600000, name: 'Probe',
          exercises: [ { id: 'a', name: 'Bench Press', sets: [ { weight: 135, reps: 8, done: true }, { weight: 135, reps: 8, done: false } ] },
            { id: 'b', name: 'Cable Row', sets: [ { weight: 90, reps: 10, done: false } ] } ] },
          templates: [], settings: { units: 'lbs', restSeconds: 120, philosophy: 'balanced' } }))
        localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: [], mesocycles: [] })); return true })()`)
      await dt.send('Page.navigate', { url: base })
      await waitFor('log', async () => await ev(`!!document.querySelector('.active-log')`))
      await sleep(300)

      console.log(`\n==== ${c.name} (${c.width}x${c.height}) ====`)

      const classes = await ev(`document.querySelector('.app').className`)
      check(classes.includes('compact') === c.compact, `${c.name}: .compact ${c.compact ? 'applies' : 'does not apply'}`, `class="${classes}"`)

      const geom = await ev(`(() => {
        const bar = document.querySelector('.tabbar'); const b = bar.getBoundingClientRect()
        const btns = [...bar.querySelectorAll('button')]
        return { bar: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: +b.height.toFixed(1) },
          buttons: btns.map((el) => { const r = el.getBoundingClientRect()
            return { x: Math.round(r.x), w: Math.round(r.width), h: +r.height.toFixed(1),
              caption: el.textContent.replace(/[^\\x20-\\x7e]/g, '').trim(),
              fontSize: getComputedStyle(el).fontSize } }) } })()`)
      note(`tab bar ${geom.bar.w}x${geom.bar.h} at (${geom.bar.x},${geom.bar.y}); button h=${geom.buttons[0].h} fontSize=${geom.buttons[0].fontSize}`)

      // The indicator must not reintroduce a band. Measure the bar and the tap target with the
      // active rule suppressed, and require the live numbers to match exactly — if the rule were
      // in flow, removing it would shrink something.
      const noRule = await ev(`(() => { const s = document.createElement('style'); s.id = 'tom69-off'
        s.textContent = '.tabbar button.active::after { display: none !important }'
        document.head.appendChild(s)
        const bar = document.querySelector('.tabbar').getBoundingClientRect()
        const btn = document.querySelector('.tabbar button').getBoundingClientRect()
        s.remove(); return { barH: +bar.height.toFixed(1), btnH: +btn.height.toFixed(1) } })()`)
      check(noRule.barH === geom.bar.h && noRule.btnH === geom.buttons[0].h,
        `${c.name}: indicator costs no vertical space`,
        `bar ${geom.bar.h} vs ${noRule.barH} without it; button ${geom.buttons[0].h} vs ${noRule.btnH}`)
      check(geom.buttons[0].h >= 28, `${c.name}: tap target still >=28px`, `${geom.buttons[0].h}px`)

      const n = geom.buttons.length
      const shot = async (index) => {
        const r = await ev(`(() => { const b = document.querySelectorAll('.tabbar button')[${index}].getBoundingClientRect()
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } })()`)
        const { data } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
          clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } })
        return { data, rect: r }
      }
      // `compact` requires the Log tab (app.tsx: `logging = tab === 'log' && !!active`), so no
      // other tab can ever be selected in a compact bar, and clicking one would leave compact
      // and resize the whole bar mid-measurement. Move the `active` class in the DOM instead:
      // the layout holds still, and the diff isolates the indicator rather than the navigation.
      const setActive = (index) => ev(`(() => { const btns = [...document.querySelectorAll('.tabbar button')]
        btns.forEach((el, k) => { el.classList.toggle('active', ${index} === k); el.offsetHeight }); return true })()`)
      const { data: wholeBar } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(join(OUT, `tom69-${c.name}-log-selected.png`), Buffer.from(wholeBar, 'base64'))

      for (let i = 0; i < n; i++) {
        const b = geom.buttons[i]
        await setActive(i); await sleep(80)
        const on = await shot(i)
        await setActive(-1); await sleep(80)
        const off = await shot(i)
        if (on.rect.w !== off.rect.w || on.rect.h !== off.rect.h || on.rect.x !== off.rect.x || on.rect.y !== off.rect.y) {
          check(false, `${c.name}: tab ${i} geometry held still`, `${JSON.stringify(on.rect)} vs ${JSON.stringify(off.rect)}`)
          continue
        }
        const diff = await ev(`(async () => {
          const load = (d) => new Promise((ok, no) => { const im = new Image()
            im.onload = () => ok(im); im.onerror = () => no(new Error('decode failed')); im.src = 'data:image/png;base64,' + d })
          const [a, b2] = await Promise.all([load(${JSON.stringify(on.data)}), load(${JSON.stringify(off.data)})])
          const w = a.width, h = a.height
          const px = (im) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h
            const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0); return cx.getImageData(0, 0, w, h).data }
          const pa = px(a), pb = px(b2)
          let count = 0, worst = 0
          for (let o = 0; o < pa.length; o += 4) {
            const d = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o+1] - pb[o+1]), Math.abs(pa[o+2] - pb[o+2]))
            if (d > 8) count++
            if (d > worst) worst = d
          }
          return { differing: count, maxChannelDelta: worst, size: [w, h] } })()`)
        check(diff.differing >= MIN_DIFF_PX,
          `${c.name}: tab ${i} (${b.caption || 'icon only'}) looks different when selected`,
          `${diff.differing} differing px of ${diff.size[0]}x${diff.size[1]} (max channel delta ${diff.maxChannelDelta})`)
      }

      // The ticket's literal expectation: in one real frame, the selected tab is distinguishable
      // from the other six. Sample the accent rule's own strip under each button's top edge, and
      // require exactly one accent-coloured strip, under the selected tab.
      await setActive(0); await sleep(120)
      const strips = await ev(`(() => { const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
        const probe = document.createElement('span'); probe.style.color = accent; document.body.appendChild(probe)
        const want = getComputedStyle(probe).color.match(/\\d+/g).map(Number); probe.remove()
        const btns = [...document.querySelectorAll('.tabbar button')]
        const bar = document.querySelector('.tabbar').getBoundingClientRect()
        return { want, bar: { x: Math.round(bar.x), y: Math.round(bar.y), w: Math.round(bar.width), h: Math.ceil(bar.height) },
          probes: btns.map((el) => { const r = el.getBoundingClientRect()
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 1) } }) } })()`)
      const { data: barPng } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
        clip: { x: strips.bar.x, y: strips.bar.y, width: strips.bar.w, height: strips.bar.h, scale: 1 } })
      const sampled = await ev(`(async () => {
        const im = await new Promise((ok, no) => { const i = new Image()
          i.onload = () => ok(i); i.onerror = () => no(new Error('decode failed')); i.src = 'data:image/png;base64,' + ${JSON.stringify(barPng)} })
        const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height
        const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0)
        const want = ${JSON.stringify(strips.want)}
        return ${JSON.stringify(strips.probes)}.map((p) => {
          const d = cx.getImageData(p.x - ${strips.bar.x}, p.y - ${strips.bar.y}, 1, 1).data
          const near = Math.max(Math.abs(d[0] - want[0]), Math.abs(d[1] - want[1]), Math.abs(d[2] - want[2])) <= 12
          return { rgb: [d[0], d[1], d[2]], accent: near } }) })()`)
      const accentTabs = sampled.map((s, k) => (s.accent ? k : -1)).filter((k) => k >= 0)
      note(`top-edge strip per tab: ${sampled.map((s) => `rgb(${s.rgb.join(',')})`).join(' ')}`)
      check(accentTabs.length === 1 && accentTabs[0] === 0,
        `${c.name}: exactly the selected tab carries the accent rule`,
        `accent strip on tab(s) [${accentTabs.join(',')}], want [0]`)

      // Second, independent cue: the emoji only renders in colour on the selected tab.
      const filters = await ev(`[...document.querySelectorAll('.tabbar .tab-icon')].map((el) => getComputedStyle(el).filter)`)
      note(`icon filter per tab: ${filters.join(' ')}`)
      check(filters[0] === 'none' && filters.slice(1).every((f) => f.includes('grayscale')),
        `${c.name}: inactive icons are desaturated, the selected one is not`, filters.join(' '))

      // And the real state, driven by clicks. Only the non-compact case can navigate without
      // leaving the posture under test; in compact, assert the Log tab the user is already on.
      if (c.compact) {
        const row = await ev(`(() => { const btns = [...document.querySelectorAll('.tabbar button')]
          return btns.map((el, k) => el.getAttribute('aria-current') === 'page' ? k : -1).filter((k) => k >= 0) })()`)
        check(row.length === 1 && row[0] === 0, `${c.name}: aria-current="page" on the Log tab`, JSON.stringify(row))
      } else {
        const ariaRows = []
        for (let s = 0; s < n; s++) {
          await ev(`(() => { document.querySelectorAll('.tabbar button')[${s}].click(); return true })()`)
          await sleep(200)
          ariaRows.push(await ev(`(() => { const btns = [...document.querySelectorAll('.tabbar button')]
            return { current: btns.map((el, k) => el.getAttribute('aria-current') === 'page' ? k : -1).filter((k) => k >= 0),
              active: btns.map((el, k) => el.classList.contains('active') ? k : -1).filter((k) => k >= 0) } })()`))
        }
        const ariaOk = ariaRows.every((r, i) => r.current.length === 1 && r.current[0] === i && r.active.length === 1 && r.active[0] === i)
        check(ariaOk, `${c.name}: clicking each tab sets active + aria-current on exactly it`, JSON.stringify(ariaRows.map((r) => r.current)))
      }

      await dt.send('Target.closeTarget', { targetId }, undefined)
      dt.sessionId = undefined
    }
  } finally { chrome.kill(); server.close() }
  console.log(`\nscreenshots: ${OUT}`)
  console.log(`\n${pass}/${pass + fail} checks passed`)
  if (fail) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
