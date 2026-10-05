#!/usr/bin/env node
// Browser evidence for the "Show AI features" switch (TOM-28).
//
// Drives the real built app in headless Chromium over the DevTools protocol: flips the
// switch by clicking it, reloads, and asserts what the board would see — the Coach tab and
// the AI provider card appearing and disappearing, the preference surviving a reload, the
// saved key still saved, and above all that not one request leaves for a provider while the
// switch is off. Every provider request is intercepted and answered locally, so the run
// needs no API key and sends nothing to Anthropic.
//
//   npm run build && node tests/ai-toggle-browser.mjs [--out <dir>]
//
// Screenshots land in the output directory (default: a temp dir, printed at the end).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const DIST = resolve('dist')
const PROVIDER_HOST = 'api.anthropic.com'
const COACH_REPLY = 'Solid session. Add a set to incline press next week.'
const outIndex = process.argv.indexOf('--out')
const OUT =
  outIndex > 0 ? resolve(process.argv[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'ai-toggle-evidence-'))

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

/** Whatever `base` the build used — '/workout-tracker/' for Pages, '/' for Cloudflare and
 *  the Android WebView — taken from the built index.html so this works on any of them. */
function builtBasePath() {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8')
  return html.match(/src="(.*?)assets\/index-/)?.[1] ?? '/'
}

/** Serves `dist` under the build's own base path, with an index fallback. */
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

async function main() {
  const basePath = builtBasePath()
  const { server, port } = await serveDist(basePath)
  const origin = `http://127.0.0.1:${port}`
  const base = `${origin}${basePath}`
  const profile = mkdtempSync(join(tmpdir(), 'ai-toggle-chrome-'))
  const chrome = spawn(
    process.env.CHROME ?? 'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      // The provider replies are synthesized by the harness, so the browser must not insist
      // on a CORS preflight to a host this run never contacts.
      '--disable-web-security',
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

    // Every request that leaves the app's own origin, in order. This is the record the
    // off-state claim rests on.
    const offsite = []
    dt.on('Network.requestWillBeSent', (p) => {
      if (!p.request.url.startsWith(origin) && !p.request.url.startsWith('data:')) offsite.push(p.request.url)
    })
    await dt.send('Page.enable')
    await dt.send('Runtime.enable')
    await dt.send('Network.enable')
    await dt.send('Network.setBypassServiceWorker', { bypass: true })
    await dt.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })

    // Answer the provider locally: the attempt is still recorded above, but nothing is sent
    // to Anthropic and no key is needed.
    const fulfilled = []
    await dt.send('Fetch.enable', { patterns: [{ urlPattern: `*${PROVIDER_HOST}*` }] })
    dt.on('Fetch.requestPaused', async (p) => {
      if (p.request.method === 'OPTIONS') {
        await dt.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 204,
          responseHeaders: [
            { name: 'access-control-allow-origin', value: '*' },
            { name: 'access-control-allow-headers', value: '*' },
            { name: 'access-control-allow-methods', value: '*' },
          ],
        })
        return
      }
      fulfilled.push(p.request.url)
      const body = JSON.stringify({ content: [{ type: 'text', text: COACH_REPLY }] })
      await dt.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        body: Buffer.from(body).toString('base64'),
      })
    })

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

    const bodyText = () => evaluate('document.body.innerText')
    const tabs = () => evaluate('[...document.querySelectorAll("nav.tabbar button")].map((b) => b.innerText.trim())')
    // The headings are the cards themselves; body text is not enough, because the switch's
    // own explanation mentions the AI provider settings by name.
    const cards = () => evaluate('[...document.querySelectorAll(".card h3")].map((h) => h.textContent.trim())')
    const keyPlaceholder = () =>
      evaluate('document.querySelector(\'input[type="password"]\')?.placeholder ?? null')
    const clickText = async (text) => {
      const hit = await evaluate(`(() => {
        const el = [...document.querySelectorAll('button, .seg button, label')]
          .find((b) => b.innerText.trim().includes(${JSON.stringify(text)}))
        if (!el) return false
        el.click()
        return true
      })()`)
      assert.equal(hit, true, `clickable "${text}"`)
      await sleep(350)
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
    const shot = async (name) => {
      const { data } = await dt.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      const file = join(OUT, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`  shot ${file}`)
      return file
    }
    const storedSettings = () => evaluate('JSON.parse(localStorage.getItem("wt.active.v1")).settings')

    // ---- seed: a configured provider and one logged session, as the board's phone has ----
    await load(base)
    const seeded = await evaluate(`(() => {
      const startedAt = Date.now() - 2 * 864e5
      localStorage.setItem('wt.active.v1', JSON.stringify({
        active: null,
        templates: [],
        settings: {
          units: 'lbs',
          restSeconds: 90,
          philosophy: 'balanced',
          ai: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-not-a-real-key', baseUrl: '' },
        },
      }))
      localStorage.setItem('wt.history.v1', JSON.stringify({
        workouts: [{
          id: 'w1', date: new Date(startedAt).toISOString().slice(0, 10), startedAt, updatedAt: startedAt,
          name: 'Push', exercises: [{ id: 'e1', name: 'Bench Press', sets: [{ weight: 140, reps: 8 }] }],
        }],
        mesocycles: [],
      }))
      return true
    })()`)
    assert.equal(seeded, true)
    await load(base)

    console.log('\nAI on (the default — nothing in storage says otherwise)')
    assert.equal('aiEnabled' in (await storedSettings()), false, 'default writes no preference')
    assert.ok((await tabs()).some((t) => t.endsWith('Coach')), 'Coach tab is present by default')
    await openTab('Settings')
    assert.match(await bodyText(), /Show AI features/, 'the switch is in Settings')
    assert.ok((await cards()).includes('AI provider'), 'the AI provider card is shown')
    assert.match(await keyPlaceholder(), /saved — enter to replace/, 'the saved key is recognized')
    await shot('01-settings-ai-on')

    await openTab('Coach')
    await clickText('Analyze')
    await waitFor('the coach reply', async () => (await bodyText()).includes(COACH_REPLY))
    // The review itself, plus the memory update the coach fires automatically after one.
    assert.ok(fulfilled.length >= 1, `provider requests while on (got ${fulfilled.length})`)
    await shot('02-coach-reply-ai-on')
    const providerCallsWhileOn = fulfilled.length
    const offsiteWhileOn = offsite.length

    console.log('\nturning the switch off')
    await openTab('Settings')
    await clickText('Off')
    const offSettings = await storedSettings()
    assert.equal(offSettings.aiEnabled, false, 'the preference is persisted as off')
    assert.deepEqual(
      offSettings.ai,
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-not-a-real-key', baseUrl: '' },
      'the provider configuration is kept',
    )
    assert.ok(!(await cards()).includes('AI provider'), 'the AI provider card is hidden')
    assert.match(await bodyText(), /nothing is sent to an AI provider/, 'the off state is explained')
    assert.ok(!(await tabs()).some((t) => t.endsWith('Coach')), 'the Coach tab is gone')
    await shot('03-settings-ai-off')

    await openTab('Plan')
    assert.doesNotMatch(await bodyText(), /Plan next meso with your coach/, 'no coach entry point on Plan')
    await shot('04-plan-ai-off')

    console.log('\nreload with the switch off')
    await load(base)
    assert.equal((await storedSettings()).aiEnabled, false, 'still off after a reload')
    assert.ok(!(await tabs()).some((t) => t.endsWith('Coach')), 'the Coach tab is still gone after a reload')
    await openTab('Settings')
    assert.ok(!(await cards()).includes('AI provider'), 'the AI provider card is still hidden')
    await shot('05-settings-ai-off-after-reload')
    assert.equal(fulfilled.length, providerCallsWhileOn, 'no provider request while off')
    const offsiteWhileOff = offsite.length - offsiteWhileOn
    assert.equal(offsiteWhileOff, 0, `no off-origin request while off (new: ${offsite.slice(offsiteWhileOn).join(', ')})`)

    console.log('\nturning the switch back on')
    await clickText('On')
    assert.equal((await storedSettings()).aiEnabled, true, 'the preference is persisted as on')
    assert.ok((await cards()).includes('AI provider'), 'the AI provider card is back')
    assert.match(await keyPlaceholder(), /saved — enter to replace/, 'the key never had to be re-entered')
    assert.ok((await tabs()).some((t) => t.endsWith('Coach')), 'the Coach tab is back')
    await openTab('Coach')
    assert.doesNotMatch(await bodyText(), /Connect an AI provider/, 'the coach is configured, not reset')
    assert.match(await bodyText(), /Training review/, 'the earlier conversation survived')
    await clickText('Analyze')
    await waitFor('a fresh coach reply', async () => fulfilled.length > providerCallsWhileOn)
    await shot('06-coach-reply-after-re-enable')

    console.log(`\nprovider requests: ${fulfilled.length} (all while on, all answered by the harness)`)
    console.log(`off-origin requests during the off window, including the reload: ${offsiteWhileOff}`)
    console.log(`PASS: browser evidence in ${OUT}`)
  } finally {
    chrome.kill('SIGKILL')
    server.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

await main()
