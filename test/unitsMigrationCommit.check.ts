// Switching units rewrites history in IndexedDB (async) and the unit in localStorage (sync).
// The unit must only change once the converted history is stored; otherwise a failed write plus a
// restart shows old lbs numbers labelled kg. Made-up data only.
import assert from 'node:assert/strict'
import { fakeWorkout, install, loadStore, makeEnv } from './idbEnv'

const unitsPath = require.resolve('../src/unitsMigration')
const metricsPath = require.resolve('../src/metricsStore')

/** A relaunch: fresh store, historyDb and metrics modules over the same storage. */
async function relaunch(env: ReturnType<typeof makeEnv>) {
  install(env)
  delete require.cache[unitsPath]
  delete require.cache[metricsPath]
  const loaded = loadStore()
  await loaded.store.initStore()
  const units = require(unitsPath) as typeof import('../src/unitsMigration')
  return { ...loaded, units }
}

const firstWeights = (s: ReturnType<typeof loadStore>['store']) =>
  s.getState().workouts[0].exercises[0].sets.map((x) => x.weight)

async function main() {
  // Failure path: the IndexedDB write fails.
  {
    const env = makeEnv()
    let { store, db, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    assert.equal(await store.commitHistory(), null)
    const before = firstWeights(store)
    assert.deepEqual(before, [100, 101, 102, 103, 104])

    const realSet = db.set
    ;(db as any).set = () => Promise.reject(new Error('disk exploded'))
    const res = await units.convertStoredWeights('lbs', 'kg')
    assert.match(res.error ?? '', /disk exploded/, 'the error is surfaced')
    assert.equal(store.getState().settings.units, 'lbs', 'unit unchanged in memory')
    assert.deepEqual(firstWeights(store), before, 'in-memory history reverted')
    ;(db as any).set = realSet

    ;({ store } = await relaunch(env))
    assert.equal(store.getState().settings.units, 'lbs', 'unit unchanged after restart')
    assert.deepEqual(firstWeights(store), before, 'weights unchanged after restart')
  }

  // Success path.
  {
    const env = makeEnv()
    let { store, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    await store.commitHistory()
    const res = await units.convertStoredWeights('lbs', 'kg')
    assert.equal(res.error, null)
    assert.equal(res.workouts, 1)
    const expected = [45.4, 45.8, 46.3, 46.7, 47.2]
    assert.equal(store.getState().settings.units, 'kg')
    assert.deepEqual(firstWeights(store), expected)

    ;({ store } = await relaunch(env))
    assert.equal(store.getState().settings.units, 'kg', 'unit kept after restart')
    assert.deepEqual(firstWeights(store), expected, 'converted weights kept after restart')
  }
  console.log('unitsMigrationCommit: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
