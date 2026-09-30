import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version
function load(name, imports = {}) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('require', 'exports', '__APP_VERSION__', js)((path) => imports[path], exports, version)
  return exports
}
const values = new Map()
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
const updates = load('updates', { './version': load('version') })
let requests = 0
const newer = { tag_name: 'v99.0.0', assets: [{ name: 'workout-tracker-release.apk', browser_download_url: 'https://github.com/TimetoSwett/workout-tracker/releases/download/v99.0.0/workout-tracker-release.apk' }] }
function respond(body, status = 200, headers = {}) {
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(body), { status, headers }) }
}
respond(newer)
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
assert.equal(requests, 1, 'relaunch retains the offer without another request')
updates.dismissUpdate('99.0.0')
assert.equal(await updates.checkForUpdateOnLaunch(), null)
assert.equal(requests, 1)
values.clear()
respond({ tag_name: version })
assert.equal((await updates.checkForUpdate()).kind, 'current')
respond(null)
assert.equal((await updates.checkForUpdate()).kind, 'unknown')
respond({}, 404)
assert.equal((await updates.checkForUpdate()).kind, 'no-releases')
respond({}, 429)
assert.equal((await updates.checkForUpdate()).kind, 'rate-limited')
respond({}, 403, { 'x-ratelimit-remaining': '0' })
assert.equal((await updates.checkForUpdate()).kind, 'rate-limited')
globalThis.fetch = async () => { throw new Error('offline') }
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'offline')
assert.equal(values.has('wt.update.lastCheckAt'), false)
respond(newer)
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
values.clear()
respond({ nonsense: true })
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'unknown')
assert.equal(values.has('wt.update.lastCheckAt'), false)
respond(newer)
const before = requests
await Promise.all([updates.checkForUpdateOnLaunch(), updates.checkForUpdateOnLaunch()])
assert.equal(requests, before + 1, 'simultaneous launches share a request')
globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
assert.equal((await updates.checkForUpdateOnLaunch()).kind, 'update-available')
console.log('PASS: cached offer, dismissal, current, malformed/null, 404, 403/429, offline retry, inconclusive retry, concurrent launch, storage unavailable')
