// History in IndexedDB: migration from both localStorage layouts, precedence, a malformed
// record, large histories, write coalescing and clearing. Made-up data only.
import assert from 'node:assert/strict'
import { fakeWorkout, histJson, install, loadStore, makeEnv, readIdb } from './idbEnv'

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

async function main() {
  const a = fakeWorkout(1)
  const b = fakeWorkout(2)
  const meso = { id: 'fake-meso', name: 'Fake', updatedAt: 5 }

  // wt.history.v1 -> IndexedDB, key removed.
  {
    const env = makeEnv({ 'wt.history.v1': histJson([a, b], [meso]) })
    install(env)
    const { store, db } = loadStore()
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id, b.id])
    assert.ok(!env.mem.has('wt.history.v1'))
    const rec = await readIdb(db)
    assert.deepEqual(ids(rec.workouts), [a.id, b.id])
    assert.equal(rec.schemaVersion, 1)
    assert.equal(store.getStorageError(), null)
  }

  // wt.v1 -> both IndexedDB and the split active key; wt.v1 removed.
  {
    const env = makeEnv({ 'wt.v1': JSON.stringify({ workouts: [a], mesocycles: [meso], templates: [], settings: { units: 'kg' } }) })
    install(env)
    const { store, db } = loadStore()
    await store.initStore()
    assert.ok(!env.mem.has('wt.v1'))
    assert.equal(JSON.parse(env.mem.get('wt.active.v1')!).settings.units, 'kg')
    assert.equal((await readIdb(db)).mesocycles.length, 1)
  }

  // A valid IndexedDB record beats both localStorage keys, and the stale keys are cleaned up.
  {
    const env = makeEnv({ 'wt.history.v1': histJson([a]), 'wt.v1': JSON.stringify({ workouts: [a], mesocycles: [] }) })
    install(env)
    const first = loadStore()
    await first.db.set(first.db.HISTORY_RECORD, { schemaVersion: 1, workouts: [a, b], mesocycles: [] })
    await first.store.initStore()
    assert.deepEqual(ids(first.store.getState().workouts), [a.id, b.id])
    assert.ok(!env.mem.has('wt.history.v1') && !env.mem.has('wt.v1'))
  }

  // Malformed IndexedDB record: fall back to localStorage and replace the record.
  for (const bad of [{ workouts: 'x', mesocycles: [] }, { workouts: [null], mesocycles: [] }, 'junk', 42]) {
    const env = makeEnv({ 'wt.history.v1': histJson([a]) })
    install(env)
    const { store, db } = loadStore()
    await db.set(db.HISTORY_RECORD, bad)
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id], `fallback over ${JSON.stringify(bad)}`)
    assert.deepEqual(ids((await readIdb(db)).workouts), [a.id])
  }

  // removeItem throwing is tolerated, and the next launch tidies up.
  {
    const env = makeEnv({ 'wt.history.v1': histJson([a]) })
    env.removeThrows = true
    install(env)
    let { store } = loadStore()
    await store.initStore()
    assert.deepEqual(ids(store.getState().workouts), [a.id])
    assert.ok(env.mem.has('wt.history.v1'))
    env.removeThrows = false
    install(env)
    ;({ store } = loadStore())
    await store.initStore()
    assert.ok(!env.mem.has('wt.history.v1'))
  }

  // ~1000 workouts: bigger than the localStorage quota, saved to IndexedDB without an error.
  {
    const many = Array.from({ length: 1000 }, (_, i) => fakeWorkout(i))
    const env = makeEnv()
    install(env)
    assert.ok(JSON.stringify(many).length > env.quotaChars, 'the data would not fit in localStorage')
    assert.throws(() => (globalThis as any).localStorage.setItem('x', JSON.stringify(many)), /full/)
    let { store } = loadStore()
    await store.initStore()
    store.setWorkouts(many)
    await store.flushHistory()
    assert.equal(store.getStorageError(), null)
    install(env)
    ;({ store } = loadStore())
    await store.initStore()
    assert.equal(store.getState().workouts.length, 1000)
    assert.equal(store.getState().workouts[999].id, 'fake-0999')
  }

  // Migrating an oversized wt.history.v1 (as left by a build that could fit it) works too.
  {
    const many = Array.from({ length: 1000 }, (_, i) => fakeWorkout(i))
    const env = makeEnv()
    env.quotaChars = Infinity
    env.mem.set('wt.history.v1', histJson(many))
    install(env)
    const { store } = loadStore()
    await store.initStore()
    assert.equal(store.getStorageError(), null)
    assert.equal(store.getState().workouts.length, 1000)
    assert.ok(!env.mem.has('wt.history.v1'))
  }

  // Rapid edits coalesce: the last snapshot wins and intermediate ones may be skipped.
  {
    const env = makeEnv()
    install(env)
    const { store, db } = loadStore()
    await store.initStore()
    let writes = 0
    const realSet = db.set
    ;(db as any).set = (k: string, v: unknown) => {
      writes++
      return realSet(k, v)
    }
    for (let i = 0; i < 20; i++) store.setWorkouts(Array.from({ length: i + 1 }, (_, n) => fakeWorkout(n)))
    await store.flushHistory()
    assert.ok(writes < 20, `coalesced (${writes} writes)`)
    assert.equal((await readIdb(db)).workouts.length, 20, 'latest snapshot is stored')
  }

  // clearHistory removes the IndexedDB record and every localStorage key.
  {
    const env = makeEnv({ 'wt.history.v1': histJson([a]) })
    install(env)
    const { store, db } = loadStore()
    await store.initStore()
    store.setWorkouts([a, b])
    await store.clearHistory()
    assert.equal(await readIdb(db), undefined)
    assert.equal(env.mem.size, 0)
  }
  console.log('storageIdb: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
