// #3: a large RP import overflowed localStorage. saveHistory() threw inside emit(),
// so listeners never ran and History never showed the imported workouts.
// The store must keep in-memory state, notify listeners, and report the failure.
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
let full = false
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (full) throw new DOMException('quota', 'QuotaExceededError')
    mem.set(k, v)
  },
  removeItem: (k: string) => void mem.delete(k),
}

const store = require('../src/store') as typeof import('../src/store')

function main() {
  let notified = 0
  store.subscribe(() => notified++)
  full = true
  const w = { id: 'fake-1', date: '2026-01-05', startedAt: 1767600000000, exercises: [] } as any
  store.setWorkouts([w])
  assert.equal(notified, 1, 'listeners still run when the save fails')
  assert.equal(store.getState().workouts.length, 1, 'in-memory state is kept')
  assert.match(store.getStorageError() ?? '', /storage is full/)
  full = false
  store.setWorkouts([w])
  assert.equal(store.getStorageError(), null, 'a later successful save clears the error')
  console.log('storageQuota: 4 checks passed')
}
main()
