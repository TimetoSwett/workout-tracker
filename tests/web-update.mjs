import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(fs.readFileSync('src/webUpdate.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText

// A fresh module instance per scenario. webUpdate.ts holds module-level state —
// the ready worker and the reload-once latch — that must not leak between tests.
function load() {
  const sw = new EventTarget()
  const registration = { waiting: null, installing: null, async update() {} }
  sw.controller = {}
  sw.getRegistration = async () => registration
  const env = { sw, registration, reloads: 0, mod: {} }
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: sw }, configurable: true })
  globalThis.location = { reload() { env.reloads++ } }
  new Function('exports', js)(env.mod)
  return env
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

{
  const env = load()
  const { sw, registration } = env
  assert.equal(await env.mod.webUpdateReady(), false, 'release without deployed worker cannot offer reload')
  await assert.rejects(env.mod.activateWebUpdate(), /No cached deployment/)
  assert.equal(env.reloads, 0)
  const worker = {
    state: 'installed',
    postMessage(message) {
      assert.deepEqual(message, { type: 'SKIP_WAITING' })
      assert.equal(env.reloads, 0, 'reload must wait for the new controller')
      sw.controller = worker
      sw.dispatchEvent(new Event('controllerchange'))
    },
  }
  registration.waiting = worker
  assert.equal(await env.mod.webUpdateReady(), true)
  await env.mod.activateWebUpdate()
  assert.equal(env.reloads, 1)
  registration.update = async () => { throw new Error('offline') }
  assert.equal(await env.mod.webUpdateReady(), true, 'downloaded update is available offline')
  registration.waiting = null
  assert.equal(await env.mod.webUpdateReady(), false)
  await assert.rejects(env.mod.activateWebUpdate())
  assert.equal(env.reloads, 1, 'offline retry must not reload stale assets')
  registration.update = async () => {}
  sw.controller = null
  assert.equal(await env.mod.webUpdateReady(), false, 'first installation is not an update')
}

// A tab that did not press Reload: clientsClaim hands it a worker whose precache
// no longer holds this build's lazy chunks, so it has to reload onto the new one.
{
  const env = load()
  env.mod.reloadOnControllerChange()
  env.sw.controller = { newDeployment: true }
  env.sw.dispatchEvent(new Event('controllerchange'))
  assert.equal(env.reloads, 1, 'a claimed tab must reload onto the deployment that claimed it')
  env.sw.dispatchEvent(new Event('controllerchange'))
  assert.equal(env.reloads, 1, 'a second claim must not stack a reload on an in-flight one')
}

// The tab that did press Reload sees the same controllerchange the watcher does.
// Exactly one navigation must come out of it.
{
  const env = load()
  env.mod.reloadOnControllerChange()
  const worker = {
    state: 'installed',
    postMessage() {
      assert.equal(env.reloads, 0, 'reload must wait for the new controller')
      env.sw.controller = worker
      env.sw.dispatchEvent(new Event('controllerchange'))
    },
  }
  env.registration.waiting = worker
  await env.mod.activateWebUpdate()
  assert.equal(env.reloads, 1, 'the initiating tab must not reload twice')
}

// First-ever install: no controller when the watcher is armed. The page already
// fetched from the network exactly what that worker precached, so claiming it is
// not a version skew and reloading would just be a flash on the first visit.
{
  const env = load()
  env.sw.controller = null
  env.mod.reloadOnControllerChange()
  env.sw.controller = { firstWorker: true }
  env.sw.dispatchEvent(new Event('controllerchange'))
  assert.equal(env.reloads, 0, 'the first worker claiming an uncontrolled page is not an update')
  env.sw.controller = { laterDeployment: true }
  env.sw.dispatchEvent(new Event('controllerchange'))
  assert.equal(env.reloads, 1, 'a first-visit tab must still reload on subsequent updates')
}

// Activation that never settles — the browser claims the page with a different
// ServiceWorker handle, so activateWebUpdate's identity check never matches and
// its promise hangs until it times out. The tab is already stale by then, so the
// watcher, not the timeout, is what has to get it onto the new deployment.
{
  const env = load()
  env.mod.reloadOnControllerChange()
  const worker = {
    state: 'installed',
    postMessage() {
      env.sw.controller = { sameDeploymentDifferentHandle: true }
      env.sw.dispatchEvent(new Event('controllerchange'))
    },
  }
  env.registration.waiting = worker
  const activation = env.mod.activateWebUpdate()
  await tick()
  assert.equal(env.reloads, 1, 'a claimed tab reloads even when activation never settles')
  // Settle the pending activation so its timeout timer is cleared.
  env.sw.controller = worker
  env.sw.dispatchEvent(new Event('controllerchange'))
  await activation
  assert.equal(env.reloads, 1, 'the late-settling activation must not reload again')
}

console.log(
  'PASS: absent deployment, activation-before-reload, offline, first install,' +
    ' claimed tab reload, no double reload, first-ever install, unsettled activation',
)
