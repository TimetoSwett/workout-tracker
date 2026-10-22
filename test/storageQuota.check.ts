// #3: a large RP import overflowed localStorage. saveHistory() threw inside emit(),
// so listeners never ran and History never showed the imported workouts.
// The store must keep in-memory state, notify listeners, and report the failure per key.
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
let fail: ((k: string) => Error | null) = () => null
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    const e = fail(k)
    if (e) throw e
    mem.set(k, v)
  },
  removeItem: (k: string) => void mem.delete(k),
}

const store = require('../src/store') as typeof import('../src/store')
const w = { id: 'fake-1', date: '2026-01-05', startedAt: 1767600000000, exercises: [] } as any
const quota = () => new DOMException('quota', 'QuotaExceededError')

function main() {
  let notified = 0
  store.subscribe(() => notified++)

  fail = () => quota()
  store.setWorkouts([w])
  assert.equal(notified, 1, 'listeners still run when the save fails')
  assert.equal(store.getState().workouts.length, 1, 'in-memory state is kept')
  assert.match(store.getStorageError() ?? '', /storage is full/)

  // History still failing; a different key saves fine. The warning must stay.
  fail = (k) => (k.includes('history') ? quota() : null)
  store.setSettings({ ...store.getState().settings })
  assert.match(store.getStorageError() ?? '', /storage is full/, 'other key saving does not hide the history failure')

  fail = () => null
  store.setWorkouts([w])
  assert.equal(store.getStorageError(), null, 'history saving again clears the error')

  // A non-quota error gets its own message.
  fail = () => new Error('disk exploded')
  store.setWorkouts([w])
  assert.match(store.getStorageError() ?? '', /Could not save to browser storage: disk exploded/)
  fail = () => null
  store.setWorkouts([w])
  assert.equal(store.getStorageError(), null)
  console.log('storageQuota: checks passed')
}
main()
