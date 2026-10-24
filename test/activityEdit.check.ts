import assert from 'node:assert/strict'
import type { Workout } from '../src/types'
const { editedActivity } = require('../src/activityEdit') as typeof import('../src/activityEdit')

const original: Workout = {
  id: 'act-1',
  date: '2026-10-20',
  startedAt: 1,
  endedAt: 2,
  name: 'Climbing — Bouldering',
  exercises: [],
  notes: 'old',
  updatedAt: 3,
  status: 'complete',
  activity: { type: 'Climbing', style: 'Bouldering', durationMin: 90 },
}

function main() {
  const snapshot = JSON.stringify(original)
  const climbing = editedActivity(
    original,
    { type: 'Climbing', style: 'Lead', durationMin: 45, date: '2026-10-22', notes: '  gym  ' },
    80,
  )
  assert.equal(JSON.stringify(original), snapshot)
  assert.equal(climbing.id, 'act-1')
  assert.equal(climbing.date, '2026-10-22')
  assert.equal(climbing.name, 'Climbing — Lead')
  assert.equal(climbing.notes, 'gym')
  assert.equal(climbing.updatedAt, 80)
  assert.deepEqual(climbing.activity, { type: 'Climbing', style: 'Lead', durationMin: 45 })
  assert.equal(climbing.endedAt, climbing.startedAt + 45 * 60000)
  assert.equal(new Date(climbing.startedAt).getHours(), 12)

  const hike = editedActivity(original, { type: 'Hiking', style: 'Lead', durationMin: 30, date: '2026-10-22' }, 80)
  assert.equal(hike.name, 'Hiking')
  assert.deepEqual(hike.activity, { type: 'Hiking', durationMin: 30 })
  assert.equal(hike.notes, undefined)

  console.log('activityEdit: 2 checks passed')
}

main()
