// An RP-style import of ~1000 made-up workouts through the same steps as MesocyclesView.importFile
// (parseRpExport, merge with existing, setHistory), then flush, relaunch on the same IndexedDB, reload.
import assert from 'node:assert/strict'
import { install, loadStore, makeEnv } from './idbEnv'
import { parseRpExport } from '../src/rpImport'

function fakeRpExport(mesos: number, daysPerMeso: number): string {
  let dayId = 1
  return JSON.stringify(
    Array.from({ length: mesos }, (_, m) => ({
      id: 1000 + m,
      name: `Fake block ${m}`,
      unit: 'lbs',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-03-01T00:00:00Z',
      finishedAt: '2024-03-01T00:00:00Z',
      priorities: { a: { muscleGroupId: 1, mgPriorityType: 'grow' } },
      weeks: Array.from({ length: 5 }, (_, w) => ({
        days: Array.from({ length: daysPerMeso / 5 }, (_, d) => {
          const id = dayId++
          const t = Date.UTC(2024, 0, 1) + id * 86_400_000
          return {
            id,
            week: w,
            position: d,
            status: 'complete',
            label: `Day ${d + 1}`,
            createdAt: new Date(t).toISOString(),
            updatedAt: new Date(t + 3_600_000).toISOString(),
            finishedAt: new Date(t + 3_600_000).toISOString(),
            exercises: Array.from({ length: 5 }, (_, e) => ({
              id: id * 10 + e,
              name: `Fake lift ${e}`,
              muscleGroupId: e + 1,
              sets: Array.from({ length: 4 }, () => ({ weight: 135, reps: 10, weightTarget: 135, repsTarget: 10, status: 'complete', finishedAt: new Date(t + 1_800_000).toISOString() })),
            })),
          }
        }),
      })),
    })),
  )
}

async function main() {
  const env = makeEnv()
  env.quotaChars = 2_500_000
  install(env)
  let { store } = loadStore()
  await store.initStore()

  const existing = { id: 'fake-existing', date: '2023-12-31', startedAt: 1_704_000_000_000, updatedAt: 1, exercises: [] } as any
  store.setWorkouts([existing])

  const raw = fakeRpExport(10, 100)
  const { workouts: importedWorkouts, mesocycles: importedMesos } = parseRpExport(raw)
  assert.equal(importedWorkouts.length, 1000)
  assert.ok(JSON.stringify(importedWorkouts).length > env.quotaChars, 'import is too big for localStorage')

  // Same merge as MesocyclesView.importFile.
  const { workouts: exW, mesocycles: exM } = store.getState()
  const wIds = new Set(importedWorkouts.map((w) => w.id))
  const mIds = new Set(importedMesos.map((m) => m.id))
  store.setHistory([...exW.filter((w) => !wIds.has(w.id)), ...importedWorkouts], [...exM.filter((m) => !mIds.has(m.id)), ...importedMesos])
  await store.flushHistory()
  assert.equal(store.getStorageError(), null, 'no quota error')

  // Relaunch on the same IndexedDB.
  install(env)
  ;({ store } = loadStore())
  await store.initStore()
  const loaded = store.getState()
  assert.equal(loaded.workouts.length, 1001)
  assert.equal(loaded.mesocycles.length, 10)
  const loadedIds = new Set(loaded.workouts.map((w) => w.id))
  for (const w of importedWorkouts) assert.ok(loadedIds.has(w.id), `${w.id} loaded`)
  assert.ok(loadedIds.has('fake-existing'))
  assert.equal(store.getStorageError(), null)
  console.log('storageRpImport: checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
