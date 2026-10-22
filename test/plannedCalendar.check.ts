// plannedForRange / nextDays / canStartPlanned: clipping, the 7-day window, inactive plans.
import assert from 'node:assert/strict'
import type { Mesocycle, Workout } from '../src/types'

process.env.TZ = 'America/New_York'

const { plannedForRange, nextDays, canStartPlanned } = require('../src/schedule') as typeof import('../src/schedule')

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
    startDate: '2026-10-19', // Monday
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

const dates = (l: { date: string }[]) => l.map((p) => p.date)

// range clipping
assert.deepEqual(dates(plannedForRange(meso(), [], '2026-10-19', '2026-10-19', '2026-10-31')), [
  '2026-10-19',
  '2026-10-22',
  '2026-10-26',
  '2026-10-29',
])
assert.deepEqual(dates(plannedForRange(meso(), [], '2026-10-19', '2026-10-20', '2026-10-26')), ['2026-10-22', '2026-10-26'])
assert.deepEqual(plannedForRange(meso(), [], '2026-10-19', '2026-10-27', '2026-10-20'), [])
// past days hold nothing; the plan slides to today
assert.deepEqual(dates(plannedForRange(meso(), [], '2026-10-21', '2026-10-01', '2026-10-22')), ['2026-10-22'])

// inactive / unscheduled / missing plans plan nothing
assert.deepEqual(plannedForRange(null, [], '2026-10-19', '2026-10-19', '2026-10-31'), [])
assert.deepEqual(plannedForRange(meso({ status: 'complete' }), [], '2026-10-19', '2026-10-19', '2026-10-31'), [])
assert.deepEqual(plannedForRange(meso({ startDate: undefined }), [], '2026-10-19', '2026-10-19', '2026-10-31'), [])
assert.deepEqual(plannedForRange(meso({ trainingWeekdays: undefined }), [], '2026-10-19', '2026-10-19', '2026-10-31'), [])
assert.ok(nextDays(meso({ startDate: undefined }), [], '2026-10-19').every((d) => d.planned.length === 0))

// next 7 days
{
  const days = nextDays(meso(), [], '2026-10-19')
  assert.equal(days.length, 7)
  assert.equal(days[0].date, '2026-10-19')
  assert.equal(days[6].date, '2026-10-25')
  assert.deepEqual(
    days.filter((d) => d.planned.length).map((d) => [d.date, d.planned[0].label]),
    [
      ['2026-10-19', 'Upper'],
      ['2026-10-22', 'Lower'],
    ],
  )
}
// logged today: done shows, the plan moves on; skips are not done
{
  const days = nextDays(meso(), [logged(), logged({ status: 'skipped', date: '2026-10-20' })], '2026-10-19')
  assert.equal(days[0].done, 1)
  assert.equal(days[1].skipped, 1)
  assert.equal(days[1].done, 0)
  // 2 slots are used up (done and skipped alike), so the next one is slot 2 and wraps to day 0.
  // Today (Mon) already has a workout, so the next session goes on the next training day, Thu.
  assert.equal(days[0].planned.length, 0)
  assert.equal(days[3].planned[0].slot, 2)
  assert.equal(days[3].planned[0].label, 'Upper')
}
// window crossing the end of DST (2026-11-01)
{
  const days = nextDays(meso({ startDate: '2026-10-28' }), [], '2026-10-30')
  assert.deepEqual(dates(days), [
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
  ])
  assert.deepEqual(dates(days.filter((d) => d.planned.length)), ['2026-11-02', '2026-11-05'])
}

// start only when the day has come
assert.equal(canStartPlanned('2026-10-19', '2026-10-19'), true)
assert.equal(canStartPlanned('2026-10-18', '2026-10-19'), true)
assert.equal(canStartPlanned('2026-10-20', '2026-10-19'), false)
assert.equal(canStartPlanned('bad', '2026-10-19'), false)

console.log('plannedCalendar checks passed')
