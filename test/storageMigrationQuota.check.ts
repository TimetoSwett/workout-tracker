// #49 / IndexedDB: if the history write to IndexedDB fails during the one-time migration,
// the app must not start empty or drop the old localStorage copy.
import assert from 'node:assert/strict'
import { fakeWorkout, install, loadStore, makeEnv } from './idbEnv'

async function main() {
  const w = fakeWorkout(1)
  const env = makeEnv({ 'wt.v1': JSON.stringify({ workouts: [w], mesocycles: [] }) })
  install(env)
  const { store, db } = loadStore()
  ;(db as any).set = async () => {
    throw new DOMException('full', 'QuotaExceededError')
  }
  await store.initStore()
  assert.equal(store.getState().workouts.length, 1, 'migrated workouts are in memory, not empty')
  assert.ok(env.mem.has('wt.v1'), 'old key is kept when the IndexedDB write fails')
  assert.match(store.getStorageError() ?? '', /storage is full/)
  console.log('storageMigrationQuota: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
