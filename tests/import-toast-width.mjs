#!/usr/bin/env node
// Browser evidence that Samsung-import feedback fits a phone (TOM-37).
//
// Drives the real built app in headless Chromium at 390x844 and provokes the three statuses
// that QA found clipped: a successful import, a failed lazy chunk, and a malformed zip. Each
// one asserts the same two things the ticket asks for — the whole status string is in the DOM
// and readable, and the document does not grow a horizontal scroll (scrollWidth ==
// clientWidth). The files are synthesized here, so the run touches no real health data.
//
//   npm run build && node tests/import-toast-width.mjs [--out <dir>]
//
// Screenshots land in the output directory (default: a temp dir, printed at the end).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const outIndex = process.argv.indexOf('--out')
const OUT =
  outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'import-toast-evidence-'))

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

/** Whatever `base` the build used, taken from the built index.html (same trick as the other
 *  browser tests) so this works on the Pages, Cloudflare and WebView builds alike. */
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

async function waitFor(what, fn, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/** Minimal flat-session DevTools client: one socket, promises for commands, taps for events. */
class Devtools {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    this.taps = new Map()
    this.sessionId = undefined
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id != null) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (!entry) return
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
        else entry.resolve(msg.result)
        return
      }
      for (const fn of this.taps.get(msg.method) ?? []) fn(msg.params)
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

  on(event, fn) {
    if (!this.taps.has(event)) this.taps.set(event, [])
    this.taps.get(event).push(fn)
  }
}

const VIEWPORT = { width: 390, height: 844 }

// A real Samsung weight export's shape: line 1 is package metadata, line 2 the header. Two
// weigh-ins on different days so the status reports both a new-day count and a bodyweight.
const WEIGHT_CSV = [
  'com.samsung.health.weight,7006011,12',
  'start_time,update_time,weight,body_fat,skeletal_muscle_mass,fat_free_mass',
  '2026-01-04 07:12:00,2026-01-04 07:12:00,82.1,18.4,34.2,67.0',
  '2026-01-05 07:04:00,2026-01-05 07:04:00,81.7,18.2,34.3,66.9',
].join('\n')
const WEIGHT_NAME = 'com.samsung.health.weight.20260105070400.csv'

// Long on purpose: a real export filename plus JSZip's own "is this a zip file?" message
// (which carries a documentation URL) is the widest status the import can produce.
const BAD_ZIP_NAME = 'samsung_health_20260105_com.samsung.shealth.tracker.pedometer_step_daily_trend.zip'

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const origin = `http://127.0.0.1:${port}`
  const base = `${origin}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'import-toast-chrome-'))
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

    const { targetId } = await dt.send('Target.createTarget', { url: 'about:blank' }, undefined)
    const { sessionId } = await dt.send('Target.attachToTarget', { targetId, flatten: true }, undefined)
    dt.sessionId = sessionId

    await dt.send('Page.enable')
    await dt.send('Runtime.enable')
    await dt.send('Network.enable')
    // The error variant is about a chunk the page cannot fetch, so the service worker must
    // not be allowed to answer from its own cache instead.
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await dt.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: true })

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await dt.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate failed')
      return result.value
    }

    const load = async (url) => {
      const loaded = new Promise((ok) => dt.on('Page.loadEventFired', ok))
      await dt.send('Page.navigate', { url })
      await loaded
      await sleep(400)
    }

    const shot = async (name) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png' })
      const file = join(OUT, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`  shot ${file}`)
      return file
    }

    const openTab = async (label) => {
      const hit = await evaluate(`(() => {
        const el = [...document.querySelectorAll('nav.tabbar button')]
          .find((b) => b.innerText.trim().endsWith(${JSON.stringify(label)}))
        if (!el) return false
        el.click()
        return true
      })()`)
      assert.equal(hit, true, `tab "${label}"`)
      await sleep(350)
    }

    /** Hands the hidden file input a synthesized File and fires the change Preact listens for. */
    const chooseFile = async (name, bytesOrText, type) => {
      const payload =
        typeof bytesOrText === 'string'
          ? JSON.stringify(bytesOrText)
          : `new Uint8Array(${JSON.stringify([...bytesOrText])})`
      const hit = await evaluate(`(() => {
        const input = document.querySelector('input[type="file"][accept=".csv,.zip"]')
        if (!input) return false
        const dt = new DataTransfer()
        dt.items.add(new File([${payload}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }))
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
      assert.equal(hit, true, 'the Samsung import file input is present')
    }

    /** The whole claim in one measurement: what the status says, and whether it fits. */
    const measureToast = () =>
      waitFor('the import status', () =>
        evaluate(`(() => {
          const el = document.querySelector('.toast.visible')
          if (!el || !el.innerText.trim()) return null
          el.scrollIntoView({ block: 'center' })
          const r = el.getBoundingClientRect()
          const doc = document.documentElement
          return {
            text: el.innerText,
            whiteSpace: getComputedStyle(el).whiteSpace,
            left: Math.round(r.left * 100) / 100,
            right: Math.round(r.right * 100) / 100,
            // > clientWidth would mean the text is cut off inside the pill itself.
            toastScrollWidth: el.scrollWidth,
            toastClientWidth: el.clientWidth,
            docScrollWidth: doc.scrollWidth,
            docClientWidth: doc.clientWidth,
            bodyScrollWidth: document.body.scrollWidth,
          }
        })()`),
      )

    const checkFits = (label, m, expectations) => {
      console.log(`  status: ${JSON.stringify(m.text)}`)
      console.log(
        `  document scrollWidth=${m.docScrollWidth} clientWidth=${m.docClientWidth}; ` +
          `toast ${m.left}..${m.right} (scrollWidth=${m.toastScrollWidth}, clientWidth=${m.toastClientWidth})`,
      )
      for (const expected of expectations) {
        assert.ok(m.text.includes(expected), `${label}: status keeps "${expected}"`)
      }
      assert.notEqual(m.whiteSpace, 'nowrap', `${label}: the status is allowed to wrap`)
      assert.equal(m.docScrollWidth, m.docClientWidth, `${label}: no horizontal document overflow`)
      assert.equal(m.docClientWidth, VIEWPORT.width, `${label}: measured at ${VIEWPORT.width}px`)
      assert.equal(m.bodyScrollWidth <= m.docClientWidth, true, `${label}: body does not overflow either`)
      assert.ok(m.left >= -0.5, `${label}: the status starts inside the viewport (left=${m.left})`)
      assert.ok(
        m.right <= m.docClientWidth + 0.5,
        `${label}: the status ends inside the viewport (right=${m.right})`,
      )
      assert.ok(
        m.toastScrollWidth <= m.toastClientWidth + 1,
        `${label}: nothing is clipped inside the status (${m.toastScrollWidth} > ${m.toastClientWidth})`,
      )
    }

    await load(base)
    await openTab('Settings')

    // ---- 1. the lazy chunk cannot be fetched -------------------------------------------
    // Done first: once healthImport has loaded successfully it stays in the module map, and
    // a later `import()` would resolve from memory however the network is blocked.
    console.log('\nlazy healthImport chunk blocked')
    await dt.send('Fetch.enable', { patterns: [{ urlPattern: '*healthImport-*' }] })
    const blocked = []
    dt.on('Fetch.requestPaused', async (p) => {
      blocked.push(p.request.url)
      await dt.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' })
    })
    await chooseFile(WEIGHT_NAME, WEIGHT_CSV, 'text/csv')
    const failure = await measureToast()
    await shot('01-import-lazy-chunk-failure-390')
    checkFits('lazy chunk failure', failure, ['Import failed'])
    assert.ok(blocked.length >= 1, `the chunk request was actually blocked (got ${blocked.length})`)
    // The point of the ticket: the module URL is still readable rather than clipped away.
    assert.match(failure.text, /healthImport-[-\w.]+\.js/, 'the failure names the chunk it could not load')
    await dt.send('Fetch.disable')

    // ---- 2. a successful import ---------------------------------------------------------
    console.log('\nsuccessful weight import')
    await load(base)
    await openTab('Settings')
    await chooseFile(WEIGHT_NAME, WEIGHT_CSV, 'text/csv')
    const success = await measureToast()
    await shot('02-import-success-390')
    checkFits('success', success, ['new days', 'updated', 'files recognized', 'bodyweight now'])
    assert.match(success.text, /2 new days/, 'both days in the CSV were imported')

    // ---- 3. a malformed zip -------------------------------------------------------------
    console.log('\nmalformed zip')
    // Reloading rather than clearing the previous status by hand: the status is Preact's own
    // node, and ripping it out of the DOM would leave the component reconciling against it.
    await load(base)
    await openTab('Settings')
    // A zip local-file-header magic number and nothing else: JSZip gets far enough to report
    // a missing central directory, which is the longest error the import surfaces.
    await chooseFile(BAD_ZIP_NAME, [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00], 'application/zip')
    const malformed = await measureToast()
    await shot('03-import-malformed-zip-390')
    checkFits('malformed zip', malformed, [BAD_ZIP_NAME])
    assert.match(malformed.text, /issues:|Import failed/, 'the malformed zip is reported')

    // The picker must be reusable after each outcome — QA checks this too, and it is cheap
    // to keep covered here now that the harness drives the input directly.
    const pickerValue = await evaluate(
      'document.querySelector(\'input[type="file"][accept=".csv,.zip"]\').value',
    )
    assert.equal(pickerValue, '', 'the file picker resets after an import')

    console.log(`\nok — three statuses wrap inside ${VIEWPORT.width}x${VIEWPORT.height}`)
    console.log(`evidence: ${OUT}`)
    server.close()
  } finally {
    chrome.kill('SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
