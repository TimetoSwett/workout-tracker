import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(fs.readFileSync('src/webUpdate.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const exports = {}
new Function('exports', js)(exports)
const sw = new EventTarget()
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true })
let reloads = 0
globalThis.location = { reload() { reloads++ } }
const registration = { waiting: null, installing: null, async update() {} }
sw.controller = {}
sw.getRegistration = async () => registration
assert.equal(await exports.webUpdateReady(), false, 'release without deployed worker cannot offer reload')
await assert.rejects(exports.activateWebUpdate(), /No cached deployment/)
assert.equal(reloads, 0)
const worker = {
  state: 'installed',
  postMessage(message) {
    assert.deepEqual(message, { type: 'SKIP_WAITING' })
    assert.equal(reloads, 0, 'reload must wait for the new controller')
    sw.controller = worker
    sw.dispatchEvent(new Event('controllerchange'))
  },
}
registration.waiting = worker
assert.equal(await exports.webUpdateReady(), true)
await exports.activateWebUpdate()
assert.equal(reloads, 1)
registration.update = async () => { throw new Error('offline') }
assert.equal(await exports.webUpdateReady(), true, 'downloaded update is available offline')
registration.waiting = null
assert.equal(await exports.webUpdateReady(), false)
await assert.rejects(exports.activateWebUpdate())
assert.equal(reloads, 1, 'offline retry must not reload stale assets')
registration.update = async () => {}
sw.controller = null
assert.equal(await exports.webUpdateReady(), false, 'first installation is not an update')
console.log('PASS: absent deployment, activation-before-reload, offline, first install')
