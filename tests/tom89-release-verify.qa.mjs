// Does the SHIPPED bundle contain the TOM-89 effort fix?
//
// TOM-89's implementation and QA were already signed off on the branch (TOM-91, TOM-92).
// The only open question when this ticket was reopened was whether the released artifact
// actually carries the fix. The TOM-88 probe answers attribution and record eligibility;
// this one reads TOM-89's own two user-visible figures off the workout card.
//
// The discriminator is the seeded session itself: a ticked 100x5 (500 lbs) next to an
// un-ticked 135x5 (675 lbs). There is no rule under which both readings are possible, so
// the card alone dates the bundle:
//
//   before TOM-89:  "2 sets ... 1,175 lbs volume"
//   after  TOM-89:  "1 set  ...   500 lbs volume"
//
// Storage isolation is a throwaway --user-data-dir, so seeding a production origin here
// cannot touch anything on this host or on the board's phone (localStorage is per-profile
// as well as per-origin). Do NOT paste the seed into the board's own browser.
//
// Usage:
//   node tests/tom89-release-verify.qa.mjs --base <url> --expect-version 2026.10.09.2e1228b
//
// Exits non-zero if any check fails.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { WebSocket } from 'undici'

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

// Omitting --base serves ./dist, which is how the negative control is run: build a
// pre-TOM-89 commit and confirm these same assertions fail on it. A plain `npm run build`
// emits base `/workout-tracker/` and only the Cloudflare build sets `/`, so read the base
// out of index.html rather than being told which one this is.
async function serveDist(root) {
  const html = await readFile(join(root, 'index.html'), 'utf8')
  const basePath = html.match(/src="(.*?)assets\/index-/)?.[1] ?? '/'
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    const rel = path.startsWith(basePath) ? path.slice(basePath.length) : path.replace(/^\//, '')
    for (const candidate of [rel && join(root, rel), join(root, 'index.html')].filter(Boolean)) {
      try {
        const body = await readFile(candidate)
        res.writeHead(200, { 'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        return res.end(body)
      } catch {}
    }
    res.writeHead(404).end('nope')
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, basePath })))
}

const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const EXPECT_VERSION = arg('--expect-version')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Same fixture as the TOM-88 probe, so one seed serves both recipes.
const SEED_WORKOUTS = [
  {
    id: 'w-completed', date: '2026-09-20', startedAt: Date.parse('2026-09-20T12:00:00Z'),
    endedAt: Date.parse('2026-09-20T13:00:00Z'), name: 'QA session',
    exercises: [{ name: 'QA Device', sets: [
      { weight: 100, reps: 5, done: true },   // counts: 1 set, 500 lbs
      { weight: 135, reps: 5, done: false },  // typed, never ticked -> must contribute nothing
    ] }],
  },
  {
    id: 'w-skipped', date: '2026-09-27', startedAt: Date.parse('2026-09-27T12:00:00Z'),
    name: 'QA skipped session', status: 'skipped',
    exercises: [{ name: 'QA Device', sets: [{ weight: 900, reps: 5, done: true }] }],
  },
]
const SEED_SETTINGS = { units: 'lbs', restSeconds: 90, philosophy: 'balanced' }
const SEED = `(() => {
  localStorage.setItem('wt.history.v1', JSON.stringify({ workouts: ${JSON.stringify(SEED_WORKOUTS)}, mesocycles: [] }))
  localStorage.setItem('wt.active.v1', JSON.stringify({ active: null, templates: [], settings: ${JSON.stringify(SEED_SETTINGS)} }))
  localStorage.setItem('wt.metrics.v1', JSON.stringify([]))
  return true })()`

let pass = 0
const failures = []
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  GAP  ${name}\n       ${detail}`) }
}

async function main() {
  const base = arg('--base')
  let server = null
  let url = base?.replace(/\/$/, '')
  if (!base) {
    const served = await serveDist(join(process.cwd(), 'dist'))
    server = served.server
    url = `http://127.0.0.1:${served.port}${served.basePath.replace(/\/$/, '')}`
  }
  console.log(`driving ${url}`)

  const profile = mkdtempSync(join(tmpdir(), 'tom89-profile-'))
  const chrome = spawn(process.env.CHROME ?? 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const wsUrl = await new Promise((ok, fail) => {
    let buf = ''
    const t = setTimeout(() => fail(new Error('chromium did not advertise a devtools endpoint')), 20000)
    chrome.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(t); ok(m[0]) }
    })
  })

  const browser = new WebSocket(wsUrl)
  await new Promise((ok) => browser.addEventListener('open', ok))
  let id = 0
  const pending = new Map()
  browser.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((ok) => { const n = ++id; pending.set(n, ok); browser.send(JSON.stringify({ id: n, method, params, sessionId })) })

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
    return r.result?.result?.value
  }
  const waitFor = async (what, fn, ms = 15000) => {
    const until = Date.now() + ms
    while (Date.now() < until) { if (await fn()) return; await sleep(150) }
    throw new Error(`timed out waiting for ${what}`)
  }
  const go = async () => {
    await send('Page.navigate', { url: url + '/' }, sessionId)
    await waitFor('app paint', async () => await ev(`!!document.querySelector('nav.tabbar')`))
  }
  const openTab = async (caption) => {
    await ev(`(() => { const b = [...document.querySelectorAll('nav.tabbar button')]
      .find((x) => x.textContent.includes(${JSON.stringify(caption)})); b && b.click(); return !!b })()`)
    await sleep(300)
  }

  try {
    await send('Page.enable', {}, sessionId)
    await go()
    check(await ev(SEED) === true, 'the synthetic seed writes all three storage keys', 'seed did not return true')
    await go()

    // Attribution first: a verdict about "the shipped bytes" is worthless without it.
    await openTab('Settings')
    const version = await ev(`(() => {
      const t = document.body.innerText.match(/20\\d\\d\\.\\d\\d\\.\\d\\d\\.[0-9a-f]{7}/)
      return t ? t[0] : null })()`)
    console.log(`\nbuild self-reports: ${version}`)
    if (EXPECT_VERSION) {
      check(version === EXPECT_VERSION, `the running build self-reports ${EXPECT_VERSION}`,
        `Settings reports ${version} — refuse the verdict, this is not the build under test`)
    } else {
      check(version != null, 'Settings names the running build', 'no version string, nothing attributes this run')
    }

    // ---------------------------------------------- the workout card (TOM-89's own figures)
    await openTab('History')
    await waitFor('workout cards', async () => await ev(`/sets/.test(document.body.innerText)`))
    const card = await ev(`(() => {
      const el = [...document.querySelectorAll('*')].reverse()
        .find((x) => /exercises ·/.test(x.textContent ?? '') && x.children.length === 0)
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null })()`)
    console.log(`\nworkout card reads: ${JSON.stringify(card)}`)

    check(card != null, 'the performed session still renders a card',
      'no card at all — the session rule is too strict and dropped a real workout')
    check(/\b1 sets?\b/.test(card ?? ''), 'the un-ticked 135x5 is not counted as a set (1 set, not 2)',
      `card reads "${card}" — "2 sets" means setCount still counts un-ticked rows`)
    check(/\b500\b/.test(card ?? ''), 'volume is the completed set only (500 lbs)',
      `card reads "${card}" — 1,175 means volumeOf still sums un-ticked rows`)
    check(!/1,?175/.test(card ?? ''), 'the un-ticked row contributes no volume',
      `card reads "${card}" — 1,175 lbs is the pre-TOM-89 figure`)

    // The weekly chart is fed by the same volumeOf, via a title attribute.
    const bars = await ev(`(() => [...document.querySelectorAll('.chart-col')]
      .map((x) => x.getAttribute('title')).filter((t) => t && !/: 0$/.test(t)))()`)
    console.log(`weekly chart non-zero bars: ${JSON.stringify(bars)}`)
    check((bars ?? []).every((b) => !/1,?175/.test(b)), 'the weekly volume chart agrees with the card',
      `a bar still reports the pre-fix total: ${JSON.stringify(bars)}`)
    // Anchored on the whole value, not a substring: a bare /500/ also matches the skipped
    // session's 4,500 bar, so it passed on the pre-TOM-89 build. Verified against that
    // build -- a check that cannot fail on the bug it guards is not a check.
    check((bars ?? []).some((b) => /:\s*500$/.test(b)), 'the weekly chart reports exactly the completed 500 lbs',
      `no bar reports 500: ${JSON.stringify(bars)}`)
    // The skipped session must contribute no bar at all. This is the figure that was
    // 4,500 before, from a 900x5 the board never performed.
    check((bars ?? []).every((b) => !/4,?500/.test(b)), 'the skipped session produces no volume bar',
      `a bar still carries the skipped session: ${JSON.stringify(bars)}`)
    check(!/900|4,?500/.test(card ?? ''), 'the skipped session does not leak into the performed card',
      `card reads "${card}"`)

    console.log(`\n${pass} ok, ${failures.length} gaps`)
    if (failures.length) { console.log('\nfailed:'); failures.forEach((f) => console.log(`  - ${f}`)) }
  } finally {
    chrome.kill()
    server?.close()
  }
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
