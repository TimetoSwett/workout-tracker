// Migration fails, a later edit saves, then a reload retries. The retry must not overwrite the
// newer edit. Also covers a failed read-back verify and an unavailable IndexedDB.
import assert from 'node:assert/strict'
import { fakeWorkout, install, loadStore, makeEnv, readIdb } from './idbEnv'

async function main() {
  const oldW = fakeWorkout(1)
  const newW = fakeWorkout(2)

  // First launch: IndexedDB writes fail. Second launch: it works and an edit is saved. Third: edit survives.
  {
    const env = makeEnv({ 'wt.v1': JSON.stringify({ workouts: [oldW], mesocycles: [] }) })
    install(env)
    let { store, db } = loadStore()
    const realSet = db.set
    ;(db as any).set = async () => {
      throw new Error('idb broken')
    }
    await store.initStore()
    assert.ok(env.mem.has('wt.v1'))
    ;(db as any).set = realSet
    store.setWorkouts([oldW, newW])
    await store.flushHistory()
    assert.equal(store.getStorageError(), null, 'a later successful save clears the error')

    install(env)
    ;({ store } = loadStore())
    await store.initStore()
    assert.deepEqual(store.getState().workouts.map((w) => w.id), [oldW.id, newW.id], 'edit survives the retried migration')
    assert.ok(!env.mem.has('wt.v1'), 'old key is removed once history is in IndexedDB')
  }

  // Failed verify: read-back differs. localStorage stays, the bad record is dropped, and the next launch migrates cleanly.
  {
    const env = makeEnv({ 'wt.history.v1': JSON.stringify({ workouts: [oldW, newW], mesocycles: [] }) })
    install(env)
    let { store, db } = loadStore()
    const realGet = db.get
    ;(db as any).get = async (k: string) => {
      const v: any = await realGet(k)
      return v && { ...v, workouts: v.workouts.slice(1) }
    }
    await store.initStore()
    assert.match(store.getStorageError() ?? '', /Could not verify/)
    assert.equal(store.getState().workouts.length, 2, 'runs from memory with full history')
    assert.ok(env.mem.has('wt.history.v1'), 'localStorage copy kept after failed verify')
    assert.equal(await realGet(db.HISTORY_RECORD), undefined, 'unverified record is removed')

    install(env)
    ;({ store, db } = loadStore())
    await store.initStore()
    assert.equal(store.getStorageError(), null)
    assert.equal(store.getState().workouts.length, 2)
    assert.ok(!env.mem.has('wt.history.v1'), 'retry migrates and removes the key')
    assert.equal((await readIdb(db)).workouts.length, 2)
  }

  // IndexedDB missing entirely: history still loads from localStorage and the error is shown.
  {
    const env = makeEnv({ 'wt.history.v1': JSON.stringify({ workouts: [oldW], mesocycles: [] }) })
    install(env)
    ;(globalThis as any).indexedDB = undefined
    const { store } = loadStore()
    await store.initStore()
    assert.equal(store.getState().workouts.length, 1)
    assert.ok(env.mem.has('wt.history.v1'))
    assert.ok(store.getStorageError())
    store.setWorkouts([oldW, newW])
    await store.flushHistory()
    assert.ok(store.getStorageError(), 'failed writes keep reporting')
  }
  console.log('storageMigrationRetry: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
