// Exercises checkForUpdate/checkForUpdateOnLaunch against fixture release
// payloads. The comparison under test is versionCode-based (see src/version.ts):
// versionName is not orderable, because a tagged build names itself '1.2.0' and
// an untagged one '2026.09.30.abc1234'. The board runs both.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

/** The build the fixtures are compared against: an untagged one, which is what
 *  the board runs today (PR artifacts are release-signed, so they install). */
const RUNNING_NAME = '2026.09.30.abc1234'
const RUNNING_CODE = 212_000_000

function load(name, imports = {}, versionCode = RUNNING_CODE) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('require', 'exports', '__APP_VERSION__', '__APP_VERSION_CODE__', js)(
    (path) => imports[path], exports, RUNNING_NAME, versionCode,
  )
  return exports
}

function loadUpdates(versionCode = RUNNING_CODE) {
  return load('updates', { './version': load('version', {}, versionCode) }, versionCode)
}

const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
}

let requests = 0
function respond(body, status = 200, headers = {}) {
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(body), { status, headers }) }
}

/** A release whose attached APK declares `code`, named the way
 *  .github/workflows/android-apk.yml names it. */
function release(name, code, { mode = 'release', tag = `v${name}` } = {}) {
  const asset = `workout-tracker-${name}-${code}-${mode}.apk`
  return {
    tag_name: tag,
    html_url: `https://github.com/TimetoSwett/workout-tracker/releases/tag/${tag}`,
    assets: [{
      name: asset,
      size: 4_400_000,
      browser_download_url: `https://github.com/TimetoSwett/workout-tracker/releases/download/${tag}/${asset}`,
    }],
  }
}

const updates = loadUpdates()

/* --- a newer release is offered, cached, and dismissible ------------------ */
const newer = release('1.1.0', RUNNING_CODE + 1)
respond(newer)
const offer = await updates.checkForUpdateOnLaunch()
assert.equal(offer.kind, 'update-available')
assert.equal(offer.version, '1.1.0', 'the offered name comes from the APK, not the tag')
assert.equal(offer.versionCode, RUNNING_CODE + 1)
assert.equal(offer.apk.sizeBytes, 4_400_000)
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
assert.equal(requests, 1, 'relaunch retains the offer without another request')

updates.dismissUpdate(RUNNING_CODE + 1)
assert.equal(await updates.checkForUpdateOnLaunch(), null, 'dismissed build stays hidden')
assert.equal(requests, 1)

// ...but dismissing one build must not mute the next one.
values.delete('wt.update.lastCheckAt')
values.delete('wt.update.lastResult')
respond(release('1.2.0', RUNNING_CODE + 2))
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available',
  'a later release is still offered after an earlier one was dismissed')
values.clear()

/* --- the versionCode comparison ------------------------------------------ */
respond(release('1.0.0', RUNNING_CODE))
assert.equal((await updates.checkForUpdate()).kind, 'current', 'equal versionCode is not an upgrade')

// The case TOM-8's scheme creates: the board is on an untagged build newer than
// the newest tag. Android would refuse this install, so it must not be offered.
respond(release('1.0.0', RUNNING_CODE - 5000))
assert.equal((await updates.checkForUpdate()).kind, 'current',
  'a release older than the running build is "current", never a downgrade offer')

// A tagged board build compared against a newer tagged release.
const tagged = loadUpdates(RUNNING_CODE - 10_000)
respond(release('1.0.0', RUNNING_CODE))
assert.equal((await tagged.checkForUpdate()).kind, 'update-available')

/* --- assets we must not offer -------------------------------------------- */
// Debug-signed: a throwaway key Android refuses over the release-signed app.
respond(release('1.1.0', RUNNING_CODE + 1, { mode: 'debug' }))
assert.equal((await updates.checkForUpdate()).kind, 'unknown', 'debug-signed asset is not installable')

// An asset name with no versionCode cannot be ordered; stay silent, don't guess.
respond({ tag_name: 'v1.1.0', assets: [{ name: 'workout-tracker-1.1.0-release.apk', browser_download_url: 'https://x/a.apk' }] })
assert.equal((await updates.checkForUpdate()).kind, 'unknown', 'un-parseable asset name is inconclusive')

respond({ tag_name: 'v1.1.0', assets: [] })
assert.equal((await updates.checkForUpdate()).kind, 'unknown', 'a release with no APK is inconclusive')

/* --- failures are results, never throws ---------------------------------- */
respond(null)
assert.equal((await updates.checkForUpdate()).kind, 'unknown')
respond({}, 404)
assert.equal((await updates.checkForUpdate()).kind, 'no-releases')
respond({}, 429)
assert.equal((await updates.checkForUpdate()).kind, 'rate-limited')
respond({}, 403, { 'x-ratelimit-remaining': '0' })
assert.equal((await updates.checkForUpdate()).kind, 'rate-limited')
respond({}, 500)
assert.equal((await updates.checkForUpdate()).kind, 'unknown')

globalThis.fetch = async () => { throw new Error('offline') }
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'offline')
assert.equal(values.has('wt.update.lastCheckAt'), false, 'an offline check is not cached as an answer')
respond(newer)
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available', 'and it retries immediately')
values.clear()

respond({ nonsense: true })
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'unknown')
assert.equal(values.has('wt.update.lastCheckAt'), false, 'an inconclusive check is not cached either')

/* --- a cached offer does not survive installing it ------------------------ */
values.clear()
respond(release('1.1.0', RUNNING_CODE + 1))
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
const installed = loadUpdates(RUNNING_CODE + 1) // the board took the update
const beforeInstalled = requests
respond(release('1.1.0', RUNNING_CODE + 1))
assert.equal((await installed.checkForUpdateOnLaunch()).kind, 'current',
  'the build just installed must not offer to install itself')
assert.equal(requests, beforeInstalled + 1, 'and it re-checks rather than trusting the stale cache')

/* --- single-flight and hostile storage ----------------------------------- */
values.clear()
respond(newer)
const before = requests
await Promise.all([updates.checkForUpdateOnLaunch(), updates.checkForUpdateOnLaunch()])
assert.equal(requests, before + 1, 'simultaneous launches share a request')

globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available', 'storage denial is survivable')

console.log('PASS: versionCode comparison (newer/equal/older/tagged), dismissal scoping, debug-signed and')
console.log('      un-parseable assets, 404/403/429/500/null/malformed, offline retry, post-install staleness,')
console.log('      concurrent launch, storage unavailable')

const multiple = release('old', RUNNING_CODE - 1)
multiple.assets.push(...newer.assets)
for (const assets of [multiple.assets, [...multiple.assets].reverse()]) {
  respond({ ...multiple, assets })
  assert.equal((await updates.checkForUpdate()).versionCode, RUNNING_CODE + 1)
}
console.log('PASS: highest APK selected in either asset order')
