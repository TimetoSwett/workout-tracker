// #49 review: a malformed split slice must not win over wt.v1, and a failing
// removeItem must not crash startup.
import assert from 'node:assert/strict'

const path = require.resolve('../src/store')
const oldW = { id: 'fake-old', date: '2025-12-01', startedAt: 1764590000000, exercises: [] }
const oldM = { id: 'fake-meso', createdAt: 1764500000000 }

function boot(history: string, removeThrows = false) {
  const mem = new Map<string, string>()
  mem.set('wt.v1', JSON.stringify({ workouts: [oldW], mesocycles: [oldM] }))
  mem.set('wt.history.v1', history)
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => { if (removeThrows) throw new Error('nope'); mem.delete(k) },
  }
  delete require.cache[path]
  const store = require(path) as typeof import('../src/store')
  return { store, mem }
}

for (const bad of ['{}', '"bad"', JSON.stringify({ workouts: [] })]) {
  const { store } = boot(bad)
  assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old'], `old workouts kept over ${bad}`)
  assert.equal(store.getState().mesocycles.length, 1, `old mesocycles kept over ${bad}`)
}

const { store, mem } = boot(JSON.stringify({ workouts: [], mesocycles: [] }), true)
assert.equal(store.getState().workouts.length, 0, 'a valid split slice still wins')
assert.ok(mem.has('wt.v1'), 'startup survives a failing removeItem')
console.log('storageMigrationInvalid: checks passed')
