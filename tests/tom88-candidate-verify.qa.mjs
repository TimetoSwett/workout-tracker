// Browser verification of the TOM-88 candidate, and the launch recipe QA can reuse on a phone.
//
// Two jobs:
//   1. Prove the candidate behaves correctly in the real app, not just in `npm run check`.
//   2. Exercise the exact synthetic-storage seed QA will paste on the preview origin, so the
//      recipe handed to the phone is one that has been run, not one that was written down.
//
// Storage isolation comes from two places and QA only gets one of them:
//   - here, a throwaway `--user-data-dir`, so nothing on this host is touched;
//   - on a phone, the *preview origin*. `localStorage` is per-origin, so seeding
//     `preview-<sha>-workout-tracker.tuckerswett.workers.dev` cannot reach the board's real
//     data on the production custom domain. That is the whole isolation argument — do not
//     run the seed against production.
//
// Usage:
//   node tests/tom88-candidate-verify.qa.mjs                 # serve ./dist (must be built)
//   node tests/tom88-candidate-verify.qa.mjs --base <url>    # drive a deployed preview
//   node tests/tom88-candidate-verify.qa.mjs --base <url> --expect-version 2026.10.09.326b92e
//                                                           # ...and refuse a build that is not that commit
//
// Exits non-zero if any check fails.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { WebSocket } from 'undici'

const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
// Attribution is opt-in rather than pinned to one commit, so this probe stays usable after
// the candidate merges. Pass the version you believe you are testing and the probe refuses
// the verdict if the running build disagrees; omit it and the version is only reported.
const EXPECT_VERSION = arg('--expect-version')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

// A plain `npm run build` emits base `/workout-tracker/` (the GitHub Pages path); only the
// Cloudflare build sets base `/`. Read the base out of index.html and strip it, so this
// drives whichever of the two is in `dist` without being told which.
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

// ---------------------------------------------------------------- the fixture
//
// QA's TOM-90 repro, plus the skipped session that produced the LOAD TRENDS finding.
// `done` is the only completion flag any write path sets, so an un-ticked row is
// `done: false` with its numbers intact — exactly what an abandoned Log row looks like.
const SEED_WORKOUTS = [
  {
    id: 'w-completed', date: '2026-09-20', startedAt: Date.parse('2026-09-20T12:00:00Z'), name: 'QA session',
    exercises: [{ name: 'QA Device', sets: [
      { weight: 100, reps: 5, done: true },    // the only set that should ever score: est 1RM 117
      { weight: 135, reps: 5, done: false },   // typed but never ticked -> must not score (would be 158)
    ] }],
  },
  {
    id: 'w-skipped', date: '2026-09-27', startedAt: Date.parse('2026-09-27T12:00:00Z'), name: 'QA skipped session',
    status: 'skipped',
    exercises: [{ name: 'QA Device', sets: [
      { weight: 900, reps: 5, done: true },    // a prescribed load on a session the board skipped
    ] }],
  },
]

// The Coach tab renders nothing but "Connect an AI provider" until `settings.ai.apiKey` is
// set, and the compiled-context size is behind that gate. A placeholder key is enough to
// render it — the size is computed locally and no request is made until Analyze is pressed.
// Nothing here is a real credential.
const SEED_SETTINGS = {
  units: 'lbs', restSeconds: 90, philosophy: 'balanced',
  ai: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'not-a-real-key-local-probe-only' },
}

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

  const profile = mkdtempSync(join(tmpdir(), 'tom88-profile-'))
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

    // The seed is the artifact QA reuses. If this fails, the recipe is wrong.
    check(await ev(SEED) === true, 'the synthetic seed writes all three storage keys', 'seed expression did not return true')
    await go()

    // ------------------------------------------------- attribution before any verdict
    await openTab('Settings')
    const version = await ev(`(() => {
      const t = document.body.innerText.match(/20\\d\\d\\.\\d\\d\\.\\d\\d\\.[0-9a-f]{7}/)
      return t ? t[0] : null })()`)
    console.log(`\nbuild self-reports: ${version}`)
    if (EXPECT_VERSION) {
      check(version === EXPECT_VERSION, `the running build self-reports ${EXPECT_VERSION}`,
        `Settings reports ${version}. A preview alias is repointable, so the version string is the attribution — refuse the verdict if this does not match.`)
    } else {
      check(version != null, 'Settings → About names the running build',
        'no version string on the Settings tab, so nothing attributes this run to a commit')
    }

    // ------------------------------------------------- Best lifts
    await openTab('History')
    await waitFor('best lifts', async () => await ev(`!!document.querySelector('.pr-row')`))
    const row = await ev(`(() => {
      const card = [...document.querySelectorAll('.card')].find((x) => x.querySelector('h3')?.textContent.includes('Best lifts'))
      const r = [...(card?.querySelectorAll('.pr-row') ?? [])]
        .find((x) => x.querySelector('span')?.textContent.includes('QA Device'))
      return r ? r.querySelector('.pr-val')?.textContent.replace(/\\s+/g, ' ').trim() : null })()`)
    console.log(`\nQA Device Best lifts row reads: ${JSON.stringify(row)}`)

    check(row != null, 'the completed set still produces a Best lifts row',
      'QA Device is absent entirely — the filter is too strict and dropped a real set')
    check(/117/.test(row ?? ''), 'the record is the completed 100x5 (est 1RM 117)', `row reads "${row}"`)
    check(!/158/.test(row ?? ''), 'the un-ticked 135x5 does not hold the record (TOM-90 repro)',
      `row reads "${row}" — 158 means done:false still scores`)
    check(!/1050|900/.test(row ?? ''), 'the skipped session\'s 900x5 does not hold the record',
      `row reads "${row}" — the skipped session is still scoring`)
    check(/2026-09-20/.test(row ?? ''), 'the record is dated to the session that earned it', `row reads "${row}"`)

    // ------------------------------------------------- the coach's context
    // The compiled prompt is not rendered anywhere, so the browser cannot read the LOAD
    // TRENDS string; `test/records.check.ts` is the gate for that. What is observable is
    // that the Coach tab still compiles a context over this history without throwing.
    await openTab('Coach')
    await sleep(400)
    if (process.argv.includes('--dump-coach')) {
      console.log('--- Coach tab text ---')
      console.log(await ev(`document.body.innerText.slice(0, 900)`))
    }
    const coachLine = await ev(`(() => {
      const m = document.body.innerText.match(/\\d+ sessions? in range[^\\n]*/)
      return m ? m[0] : null })()`)
    console.log(`\nCoach context line: ${JSON.stringify(coachLine)}`)
    check(coachLine != null, 'the Coach tab compiles a context over the seeded history',
      'no "N sessions in range" line — compileWorkouts may have thrown')

    console.log(`\n${pass} ok, ${failures.length} gaps`)
    if (failures.length) { console.log('\nfailed:'); failures.forEach((f) => console.log(`  - ${f}`)) }
  } finally {
    chrome.kill()
    server?.close()
  }
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
