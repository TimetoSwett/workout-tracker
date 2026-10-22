// #49 review: a malformed split slice must not win over wt.v1, and a failing
// removeItem must not crash startup. Now with history in IndexedDB.
import assert from 'node:assert/strict'
import { histJson, install, loadStore, makeEnv } from './idbEnv'

const oldW = { id: 'fake-old', date: '2025-12-01', startedAt: 1764590000000, exercises: [] }
const oldM = { id: 'fake-meso', createdAt: 1764500000000 }

async function boot(history: string | null, removeThrows = false, legacy: unknown = { workouts: [oldW], mesocycles: [oldM] }, active?: string) {
  const env = makeEnv({ 'wt.v1': JSON.stringify(legacy) })
  if (history !== null) env.mem.set('wt.history.v1', history)
  if (active) env.mem.set('wt.active.v1', active)
  env.removeThrows = removeThrows
  install(env)
  const { store, db } = loadStore()
  await store.initStore()
  return { store, db, env }
}

async function main() {
  for (const bad of ['{}', '"bad"', JSON.stringify({ workouts: [] }), JSON.stringify({ workouts: [null], mesocycles: [] })]) {
    const { store } = await boot(bad)
    assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old'], `old workouts kept over ${bad}`)
    assert.equal(store.getState().mesocycles.length, 1, `old mesocycles kept over ${bad}`)
  }

  {
    const { store, env } = await boot(histJson([]), true)
    assert.equal(store.getState().workouts.length, 0, 'a valid split slice still wins')
    assert.ok(env.mem.has('wt.v1'), 'startup survives a failing removeItem')
  }
  // wt.v1 holding JSON null must not crash startup.
  {
    const { store } = await boot(histJson([oldW]), false, null)
    assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old'], 'falls back to split storage')
  }

  // An active slice without `active` keeps the legacy in-progress workout.
  {
    const legacyActive = { id: 'fake-active', startedAt: 1764600000000, exercises: [] }
    const { store } = await boot(null, false, { workouts: [], mesocycles: [], active: legacyActive }, JSON.stringify({ templates: [], settings: {} }))
    assert.equal((store.getState().active as any)?.id, 'fake-active', 'legacy active workout is kept')
  }

  // Reload twice: the recovered legacy workout must be saved before wt.v1 goes.
  {
    const legacyActive = { id: 'fake-active2', startedAt: 1764600000000, exercises: [] }
    const { env } = await boot(null, false, { workouts: [], mesocycles: [], active: legacyActive }, JSON.stringify({ templates: [], settings: {} }))
    assert.ok(!env.mem.has('wt.v1'))
    assert.equal(JSON.parse(env.mem.get('wt.active.v1')!).active?.id, 'fake-active2', 'recovered workout is written to the split key')
    install(env)
    const again = loadStore().store
    await again.initStore()
    assert.equal((again.getState().active as any)?.id, 'fake-active2', 'survives a second reload')
  }

  // An active:null saved on purpose (finished/cancelled) must not bring the legacy workout back.
  {
    const { store } = await boot(null, false, { workouts: [], mesocycles: [], active: { id: 'fake-stale', startedAt: 1, exercises: [] } }, JSON.stringify({ active: null, templates: [], settings: {} }))
    assert.equal(store.getState().active, null, 'deliberate active:null wins')
  }

  // templates:[null] falls back to legacy templates.
  {
    const { store } = await boot(null, false, { workouts: [], mesocycles: [], templates: [{ id: 'fake-t', name: 'Fake', exercises: [] }] }, JSON.stringify({ templates: [null], settings: {} }))
    assert.deepEqual(store.getState().templates.map((t: any) => t.id), ['fake-t'], 'legacy templates kept over bad elements')
  }
  console.log('storageMigrationInvalid: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
