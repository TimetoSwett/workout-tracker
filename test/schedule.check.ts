// plannedSessions: weekday placement, DST, sliding missed days, skips, and missing fields.
import assert from 'node:assert/strict'
import type { Mesocycle, Workout } from '../src/types'

process.env.TZ = 'America/New_York'

const { plannedSessions, isValidTrainingWeekdays } = require('../src/schedule') as typeof import('../src/schedule')
const { dayMarkers } = require('../src/calendar') as typeof import('../src/calendar')

function meso(over: Partial<Mesocycle> = {}): Mesocycle {
  return {
    id: 'm1',
    name: 'Plan',
    unit: 'lbs',
    weeksPlanned: 2,
    days: [
      { id: 'd1', label: 'Upper', exercises: [] },
      { id: 'd2', label: 'Lower', exercises: [] },
    ],
    priorities: [],
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    startDate: '2026-10-19', // a Monday
    trainingWeekdays: [1, 4], // Mon, Thu
    ...over,
  }
}

let n = 0
const logged = (over: Partial<Workout> = {}): Workout => ({
  id: `w${++n}`,
  date: '2026-10-19',
  startedAt: n,
  updatedAt: n,
  exercises: [],
  mesoId: 'm1',
  ...over,
})

const dates = (s: { date: string }[]) => s.map((p) => p.date)

// weekday placement, slot numbering, labels; never before today
{
  const s = plannedSessions(meso(), [], { today: '2026-10-19' })
  assert.deepEqual(dates(s), ['2026-10-19', '2026-10-22', '2026-10-26', '2026-10-29'])
  assert.deepEqual(
    s.map((p) => [p.slot, p.week, p.dayIndex, p.label]),
    [
      [0, 0, 0, 'Upper'],
      [1, 0, 1, 'Lower'],
      [2, 1, 0, 'Upper'],
      [3, 1, 1, 'Lower'],
    ],
  )
  // today is Tuesday: first session is Thursday, not the past Monday
  assert.deepEqual(dates(plannedSessions(meso(), [], { today: '2026-10-20' })).slice(0, 2), ['2026-10-22', '2026-10-26'])
}

// a future startDate holds the plan back
{
  const s = plannedSessions(meso({ startDate: '2026-11-02' }), [], { today: '2026-10-20' })
  assert.equal(s[0].date, '2026-11-02')
}

// DST ends 2026-11-01: dates stay on the right weekdays
{
  const m = meso({ weeksPlanned: 4, startDate: '2026-10-26', trainingWeekdays: [0, 3] }) // Sun, Wed
  const s = plannedSessions(m, [], { today: '2026-10-26' })
  assert.deepEqual(dates(s), ['2026-10-28', '2026-11-01', '2026-11-04', '2026-11-08', '2026-11-11', '2026-11-15', '2026-11-18', '2026-11-22'])
}

// logged sessions consume slots; a missed day slides to the next training day
{
  const s = plannedSessions(meso(), [logged()], { today: '2026-10-23' }) // Thu 22nd was missed
  assert.deepEqual(dates(s), ['2026-10-26', '2026-10-29', '2026-11-02'])
  assert.equal(s[0].slot, 1)
}

// skipped counts, deleted does not, other mesos do not
{
  const ws = [logged({ status: 'skipped' }), logged({ deleted: true }), logged({ mesoId: 'other' })]
  const s = plannedSessions(meso(), ws, { today: '2026-10-19' })
  assert.equal(s[0].slot, 1)
  assert.equal(s.length, 3)
}

// several sessions on one day use up several slots
{
  const s = plannedSessions(meso(), [logged(), logged(), logged()], { today: '2026-10-19' })
  assert.deepEqual(s.map((p) => p.slot), [3])
  assert.deepEqual(plannedSessions(meso(), [logged(), logged(), logged(), logged()], { today: '2026-10-19' }), [])
}

// from / to / limit
{
  const t = { today: '2026-10-19' }
  assert.deepEqual(dates(plannedSessions(meso(), [], { ...t, from: '2026-10-23', to: '2026-10-29' })), ['2026-10-26', '2026-10-29'])
  assert.deepEqual(dates(plannedSessions(meso(), [], { ...t, limit: 1 })), ['2026-10-19'])
  assert.deepEqual(plannedSessions(meso(), [], { ...t, limit: 0 }), [])
}

// missing or invalid fields, finished and deleted plans
{
  const t = { today: '2026-10-19' }
  assert.deepEqual(plannedSessions(meso({ startDate: undefined }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ trainingWeekdays: undefined }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ trainingWeekdays: [] }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ trainingWeekdays: [4, 1] }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ trainingWeekdays: [7] }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ startDate: '2026-02-30' }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ status: 'complete' }), [], t), [])
  assert.deepEqual(plannedSessions(meso({ deleted: true }), [], t), [])
  assert.deepEqual(plannedSessions(meso(), [], { today: 'nope' }), [])
  assert.ok(isValidTrainingWeekdays([0, 3, 6]))
  assert.ok(!isValidTrainingWeekdays([1, 1]))
}

// dayMarkers hook
{
  const planned = plannedSessions(meso(), [], { today: '2026-10-19' })
  const m = dayMarkers([logged()], { planned, to: '2026-10-22' })
  assert.deepEqual(m.get('2026-10-19'), { done: 1, skipped: 0, planned: 1 })
  assert.deepEqual(m.get('2026-10-22'), { done: 0, skipped: 0, planned: 1 })
  assert.equal(m.has('2026-10-26'), false)
}

console.log('schedule checks passed')
