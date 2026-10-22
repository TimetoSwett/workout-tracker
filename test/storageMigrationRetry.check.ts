// #49 review: migration fails (storage full), a later edit saves to the split key,
// then a reload retries migration. The retry must not overwrite the newer edit.
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
const oldW = { id: 'fake-old', date: '2025-12-01', startedAt: 1764590000000, exercises: [] }
const newW = { id: 'fake-new', date: '2025-12-02', startedAt: 1764680000000, exercises: [] }
mem.set('wt.v1', JSON.stringify({ workouts: [oldW], mesocycles: [] }))
let full = true
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { if (full) throw new DOMException('full', 'QuotaExceededError'); mem.set(k, v) },
  removeItem: (k: string) => void mem.delete(k),
}

const path = require.resolve('../src/store')
let store = require(path) as typeof import('../src/store')
assert.ok(mem.has('wt.v1'))
full = false
store.setWorkouts([oldW, newW] as any)

delete require.cache[path]
store = require(path) as typeof import('../src/store')
assert.deepEqual(store.getState().workouts.map((w) => w.id), ['fake-old', 'fake-new'], 'edit survives the retried migration')
assert.ok(!mem.has('wt.v1'), 'old key is removed once both split keys exist')
console.log('storageMigrationRetry: checks passed')
