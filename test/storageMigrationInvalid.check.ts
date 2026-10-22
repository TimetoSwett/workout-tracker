// #49 review: a malformed split slice must not win over wt.v1, and a failing
// removeItem must not crash startup.
import assert from 'node:assert/strict'

const path = require.resolve('../src/store')
const oldW = { id: 'fake-old', date: '2025-12-01', startedAt: 1764590000000, exercises: [] }
const oldM = { id: 'fake-meso', createdAt: 1764500000000 }

function boot(history: string | null, removeThrows = false, legacy: unknown = { workouts: [oldW], mesocycles: [oldM] }, active?: string) {
  const mem = new Map<string, string>()
  mem.set('wt.v1', JSON.stringify(legacy))
  if (history !== null) mem.set('wt.history.v1', history)
  if (active) mem.set('wt.active.v1', active)
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => { if (removeThrows) throw new Error('nope'); mem.delete(k) },
  }
  delete require.cache[path]
  const store = require(path) as typeof import('../src/store')
  return { store, mem }
}

for (const bad of ['{}', '"bad"', JSON.stringify({ workouts: [] }), JSON.stringify({ workouts: [null], mesocycles: [] })]) {
  const { store } = boot(bad)
  assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old'], `old workouts kept over ${bad}`)
  assert.equal(store.getState().mesocycles.length, 1, `old mesocycles kept over ${bad}`)
}

const { store, mem } = boot(JSON.stringify({ workouts: [], mesocycles: [] }), true)
assert.equal(store.getState().workouts.length, 0, 'a valid split slice still wins')
assert.ok(mem.has('wt.v1'), 'startup survives a failing removeItem')
// wt.v1 holding JSON null must not crash startup.
{
  const { store } = boot(JSON.stringify({ workouts: [oldW], mesocycles: [] }), false, null)
  assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old'], 'falls back to split storage')
}

// An active slice without `active` keeps the legacy in-progress workout.
{
  const legacyActive = { id: 'fake-active', startedAt: 1764600000000, exercises: [] }
  const { store } = boot(null, false, { workouts: [], mesocycles: [], active: legacyActive }, JSON.stringify({ templates: [], settings: {} }))
  assert.equal((store.getState().active as any)?.id, 'fake-active', 'legacy active workout is kept')
}

// Reload twice: the recovered legacy workout must be saved before wt.v1 goes.
{
  const legacyActive = { id: 'fake-active2', startedAt: 1764600000000, exercises: [] }
  const { mem } = boot(null, false, { workouts: [], mesocycles: [], active: legacyActive }, JSON.stringify({ templates: [], settings: {} }))
  assert.ok(!mem.has('wt.v1'))
  assert.equal(JSON.parse(mem.get('wt.active.v1')!).active?.id, 'fake-active2', 'recovered workout is written to the split key')
  ;(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
  delete require.cache[path]
  const again = require(path) as typeof import('../src/store')
  assert.equal((again.getState().active as any)?.id, 'fake-active2', 'survives a second reload')
}

// An active:null saved on purpose (finished/cancelled) must not bring the legacy workout back.
{
  const { store } = boot(null, false, { workouts: [], mesocycles: [], active: { id: 'fake-stale', startedAt: 1, exercises: [] } }, JSON.stringify({ active: null, templates: [], settings: {} }))
  assert.equal(store.getState().active, null, 'deliberate active:null wins')
}

// templates:[null] falls back to legacy templates.
{
  const { store } = boot(null, false, { workouts: [], mesocycles: [], templates: [{ id: 'fake-t', name: 'Fake', exercises: [] }] }, JSON.stringify({ templates: [null], settings: {} }))
  assert.deepEqual(store.getState().templates.map((t: any) => t.id), ['fake-t'], 'legacy templates kept over bad elements')
}

console.log('storageMigrationInvalid: checks passed')
