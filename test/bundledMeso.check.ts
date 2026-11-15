// The Upper Hypertrophy plan is inserted once, scheduled from Sunday 2026-11-15,
// and does not come back after it has been saved or deleted.
import assert from 'node:assert/strict'
import type { Mesocycle } from '../src/types'
const { UPPER_HYPERTROPHY_ID, insertUpperHypertrophy, upperHypertrophyMeso } =
  require('../src/bundledMeso') as typeof import('../src/bundledMeso')

const now = 1_700_000_000_000

function main() {
  const meso = upperHypertrophyMeso(now)
  assert.equal(meso.id, UPPER_HYPERTROPHY_ID)
  assert.equal(meso.name, 'Upper Hypertrophy')
  assert.equal(meso.status, 'active')
  assert.equal(meso.unit, 'lbs')
  assert.equal(meso.weeksPlanned, 5)
  assert.equal(meso.deloadWeek, 4)
  assert.equal(meso.startDate, '2026-11-15')
  assert.deepEqual(meso.trainingWeekdays, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(meso.days.map((d) => d.label), [
    'Sunday — Press + Pull',
    'Monday — Legs (Maintenance)',
    'Tuesday — Press + Triceps',
    'Wednesday — Delts + Legs',
    'Thursday — Triceps + Delts',
    'Friday — Arms + Legs',
  ])
  assert.deepEqual(meso.days[0].exercises.map((e) => [e.name, e.sets, e.repTarget]), [
    ['Smith Machine Bench Press', 4, [4, 8]],
    ['Barbell Skullcrusher', 3, [10, 15]],
    ['Machine Preacher Curl', 3, [6, 10]],
    ['Pulldown (Normal Grip)', 3, [8, 12]],
  ])
  assert.equal(meso.priorities.find((p) => p.muscleGroupId === 1)?.type, 'emphasize')
  assert.equal(meso.priorities.find((p) => p.muscleGroupId === 6)?.type, 'maintain')

  const other: Mesocycle = { ...meso, id: 'old', name: 'Old', status: 'active', imported: false }
  const imported: Mesocycle = { ...meso, id: 'rp', name: 'RP', status: 'active', imported: true }
  const added = insertUpperHypertrophy([other, imported], now)
  assert.ok(added)
  assert.equal(added!.find((m) => m.id === 'old')?.status, 'complete')
  assert.equal(added!.find((m) => m.id === 'rp')?.status, 'active')
  assert.equal(added!.find((m) => m.id === UPPER_HYPERTROPHY_ID)?.status, 'active')
  assert.equal(insertUpperHypertrophy(added!, now), null)
  assert.equal(insertUpperHypertrophy([{ ...meso, deleted: true }], now), null)
  console.log('bundledMeso: ok')
}

main()
