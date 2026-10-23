// #3: a large RP import overflowed localStorage. The store must keep in-memory state, notify
// listeners, and report a failed save. History now saves to IndexedDB, so failures come from there.
import assert from 'node:assert/strict'
import { fakeWorkout, install, loadStore, makeEnv } from './idbEnv'

async function main() {
  install(makeEnv())
  const { store, db } = loadStore()
  await store.initStore()
  const realSet = db.set
  let fail: Error | null = null
  ;(db as any).set = (k: string, v: unknown) => (fail ? Promise.reject(fail) : realSet(k, v))
  const w = fakeWorkout(1)
  const quota = () => new DOMException('quota', 'QuotaExceededError')

  let notified = 0
  store.subscribe(() => notified++)

  fail = quota()
  store.setWorkouts([w])
  assert.equal(notified, 1, 'listeners run synchronously')
  await store.flushHistory()
  assert.ok(notified >= 2, 'listeners run again when the save error appears')
  assert.equal(store.getState().workouts.length, 1, 'in-memory state is kept')
  assert.match(store.getStorageError() ?? '', /storage is full/)

  // History still failing; the active slice saves fine to localStorage. The warning must stay.
  store.setSettings({ ...store.getState().settings })
  assert.match(store.getStorageError() ?? '', /storage is full/, 'other key saving does not hide the history failure')

  fail = null
  store.setWorkouts([w])
  await store.flushHistory()
  assert.equal(store.getStorageError(), null, 'history saving again clears the error')

  fail = new Error('disk exploded')
  store.setWorkouts([w])
  await store.flushHistory()
  assert.match(store.getStorageError() ?? '', /Could not save to browser storage: disk exploded/)
  fail = null
  store.setWorkouts([w])
  await store.flushHistory()
  assert.equal(store.getStorageError(), null)
  console.log('storageQuota: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
