// Regression tests for three history data-loss bugs. Made-up data only.
import assert from 'node:assert/strict'
import { fakeWorkout, histJson, install, loadStore, makeEnv, readIdb } from './idbEnv'

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

async function main() {
  const a = fakeWorkout(1)
  const b = fakeWorkout(2)

  // 1. A flush with nothing queued must not wedge the writer.
  {
    const env = makeEnv()
    install(env)
    let { store } = loadStore()
    await store.initStore()
    await store.flushHistory() // idle flush (visibilitychange / pagehide)
    store.upsertWorkout(a)
    await store.flushHistory()
    install(env)
    ;({ store } = loadStore())
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id], 'save after an idle flush persisted across restart')
  }

  // 2. A failing IndexedDB read must not let a later save replace the real record.
  {
    const env = makeEnv()
    install(env)
    const first = loadStore()
    await first.store.initStore()
    first.store.setWorkouts([a, b])
    await first.store.flushHistory()

    // Transient failure: the retry succeeds and history loads normally.
    install(env)
    let { store, db } = loadStore()
    const realGet = db.get
    let calls = 0
    ;(db as any).get = (k: string) => (++calls < 2 ? Promise.reject(new Error('transient')) : realGet(k))
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id, b.id])
    assert.equal(store.getStorageError(), null)

    // Persistent failure: writes are blocked, the error is surfaced, the record is untouched.
    install(env)
    ;({ store, db } = loadStore())
    ;(db as any).get = () => Promise.reject(new Error('read broke'))
    await store.initStore()
    assert.match(store.getStorageError() ?? '', /read broke/)
    store.upsertWorkout(fakeWorkout(3))
    await store.flushHistory()
    assert.match(store.getStorageError() ?? '', /read broke/)
    install(env)
    const check = loadStore()
    assert.deepEqual(ids((await readIdb(check.db)).workouts), [a.id, b.id], 'IDB record not overwritten')

    // With a localStorage copy, that copy is shown (and left alone).
    const env2 = makeEnv({ 'wt.history.v1': histJson([a]) })
    install(env2)
    ;({ store, db } = loadStore())
    ;(db as any).get = () => Promise.reject(new Error('read broke'))
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id])
    assert.ok(env2.mem.has('wt.history.v1'))
    assert.ok(store.getStorageError())
  }

  // 3. finishWorkout clears the active workout only after the write commits.
  {
    const env = makeEnv()
    install(env)
    let { store, db } = loadStore()
    await store.initStore()
    const active: any = { ...fakeWorkout(5), endedAt: undefined }
    store.setActive(active)
    const err = await store.finishWorkout({ ...active, endedAt: 1 })
    assert.equal(err, null)
    assert.equal(store.getState().active, null)
    assert.deepEqual(ids((await readIdb(db)).workouts), [active.id], 'committed before active cleared')

    // Failing write: active is kept and the error is returned.
    const env2 = makeEnv()
    install(env2)
    ;({ store, db } = loadStore())
    await store.initStore()
    ;(db as any).set = () => Promise.reject(new Error('disk full'))
    store.setActive(active)
    const err2 = await store.finishWorkout({ ...active, endedAt: 1 })
    assert.match(err2 ?? '', /disk full/)
    assert.equal(store.getState().active?.id, active.id, 'active workout kept')
  }
  console.log('storageDataLoss: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
