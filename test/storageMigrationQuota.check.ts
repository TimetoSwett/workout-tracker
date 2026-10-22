// #49: if storage is full during the one-time split of the old 'wt.v1' key,
// the app must not start empty or drop the old key.
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
mem.set('wt.v1', JSON.stringify({ workouts: [{ id: 'fake-m1', date: '2025-12-01', startedAt: 1764590000000, exercises: [] }], mesocycles: [] }))
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: () => { throw new DOMException('full', 'QuotaExceededError') },
  removeItem: (k: string) => void mem.delete(k),
}

const store = require('../src/store') as typeof import('../src/store')
assert.equal(store.getState().workouts.length, 1, 'migrated workouts are in memory, not empty')
assert.ok(mem.has('wt.v1'), 'old key is kept when the split save fails')
assert.match(store.getStorageError() ?? '', /storage is full/)
console.log('storageMigrationQuota: checks passed')
