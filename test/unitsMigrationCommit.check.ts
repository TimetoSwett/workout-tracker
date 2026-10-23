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
  const metricsRow = { date: '2025-01-02', weight: 200, updatedAt: 1 }
  const METRICS_KEY = 'wt.metrics.v1'
  const metricsWeights = (env: ReturnType<typeof makeEnv>) =>
    JSON.parse(env.mem.get(METRICS_KEY) ?? '[]').map((m: { weight: number }) => m.weight)
  /** Makes localStorage.setItem throw for one key, after `relaunch` installed the fake. */
  const failKey = (key: string) => {
    const ls = (globalThis as any).localStorage
    const real = ls.setItem
    ls.setItem = (k: string, v: string) => {
      if (k === key) throw new DOMException('full', 'QuotaExceededError')
      real(k, v)
    }
    return () => (ls.setItem = real)
  }

  // setMetrics throws after the history commit: history must go back, then a restart agrees.
  {
    const env = makeEnv({ [METRICS_KEY]: JSON.stringify([metricsRow]) })
    let { store, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    await store.commitHistory()
    const before = firstWeights(store)
    const restore = failKey(METRICS_KEY)
    const res = await units.convertStoredWeights('lbs', 'kg')
    assert.match(res.error ?? '', /full/, 'the metrics failure is returned')
    assert.equal(store.getState().settings.units, 'lbs')
    assert.deepEqual(firstWeights(store), before, 'in-memory history reverted')
    restore()

    ;({ store } = await relaunch(env))
    assert.equal(store.getState().settings.units, 'lbs', 'unit unchanged after restart')
    assert.deepEqual(firstWeights(store), before, 'stored history is the original after restart')
    assert.deepEqual(metricsWeights(env), [200], 'metrics unchanged after restart')
  }

  // The settings save fails after history and metrics were written: everything is put back.
  {
    const env = makeEnv({ [METRICS_KEY]: JSON.stringify([metricsRow]) })
    let { store, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    await store.commitHistory()
    store.setActive({ id: 'a1', exercises: [{ id: 'e', name: 'Fake', sets: [{ weight: 100, reps: 5 }] }] } as any)
    const before = firstWeights(store)
    const restore = failKey('wt.active.v1')
    const res = await units.convertStoredWeights('lbs', 'kg')
    assert.notEqual(res.error, null, 'the settings failure is returned')
    assert.equal(store.getState().settings.units, 'lbs')
    assert.equal(store.getState().active?.exercises[0].sets[0].weight, 100, 'active workout restored')
    assert.deepEqual(firstWeights(store), before)
    restore()

    ;({ store } = await relaunch(env))
    assert.equal(store.getState().settings.units, 'lbs', 'unit unchanged after restart')
    assert.deepEqual(firstWeights(store), before, 'history original after restart')
    assert.deepEqual(metricsWeights(env), [200], 'metrics original after restart')
    assert.equal(store.getState().active?.exercises[0].sets[0].weight, 100)
  }

  // An edit made while the conversion is running is refused, not silently lost.
  {
    const env = makeEnv()
    let { store, db, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    await store.commitHistory()
    const realSet = db.set
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(db as any).set = async (...a: Parameters<typeof realSet>) => {
      await gate
      return realSet(...a)
    }
    const running = units.convertStoredWeights('lbs', 'kg')
    assert.equal(store.isConverting(), true)
    assert.throws(() => store.setWorkouts([fakeWorkout(2)]), /being converted/, 'history edit is blocked')
    assert.throws(() => store.upsertWorkout(fakeWorkout(3)), store.ConversionInProgressError)
    assert.throws(() => store.setHistory([], []), store.ConversionInProgressError)
    release()
    const res = await running
    ;(db as any).set = realSet
    assert.equal(res.error, null)
    assert.equal(store.isConverting(), false, 'edits allowed again afterwards')
    assert.equal(store.getState().workouts.length, 1, 'the blocked edit did not land')
    store.upsertWorkout(fakeWorkout(4))
    assert.equal(await store.commitHistory(), null)
    ;({ store } = await relaunch(env))
    assert.equal(store.getState().workouts.length, 2)
    assert.equal(store.getState().settings.units, 'kg')
  }

  // Success path with metrics and an active workout.
  {
    const env = makeEnv({ [METRICS_KEY]: JSON.stringify([metricsRow]) })
    let { store, units } = await relaunch(env)
    store.setWorkouts([fakeWorkout(1)])
    await store.commitHistory()
    store.setActive({ id: 'a1', exercises: [{ id: 'e', name: 'Fake', sets: [{ weight: 100, reps: 5 }] }] } as any)
    const res = await units.convertStoredWeights('lbs', 'kg')
    assert.equal(res.error, null)
    assert.equal(res.metrics, 1)
    ;({ store } = await relaunch(env))
    assert.equal(store.getState().settings.units, 'kg')
    assert.deepEqual(metricsWeights(env), [90.7])
    assert.equal(store.getState().active?.exercises[0].sets[0].weight, 45.4)
    assert.deepEqual(firstWeights(store), [45.4, 45.8, 46.3, 46.7, 47.2])
  }
  console.log('unitsMigrationCommit: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
