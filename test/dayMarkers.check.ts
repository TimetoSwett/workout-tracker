// dayMarkers: per-day done/skipped counts, keyed by dateOf, ignoring deleted rows.
import assert from 'node:assert/strict'
import type { Workout } from '../src/types'
const { dayMarkers, localDatesWithWorkouts } = require('../src/calendar') as typeof import('../src/calendar')

process.env.TZ = 'America/Los_Angeles'

let n = 0
function w(over: Partial<Workout>): Workout {
  return { id: `w${++n}`, date: '2026-03-08', startedAt: new Date(2026, 2, 8, 9).getTime(), exercises: [], updatedAt: 0, ...over }
}

// several workouts on one day
{
  const m = dayMarkers([w({}), w({ status: 'complete' }), w({ status: 'partial' })])
  assert.deepEqual([...m.entries()], [['2026-03-08', { done: 3, skipped: 0, planned: 0 }]])
}

// skipped is not done
{
  const m = dayMarkers([w({ status: 'skipped' }), w({}), w({ date: '2026-03-09', status: 'skipped' })])
  assert.deepEqual(m.get('2026-03-08'), { done: 1, skipped: 1, planned: 0 })
  assert.deepEqual(m.get('2026-03-09'), { done: 0, skipped: 1, planned: 0 })
  assert.deepEqual([...localDatesWithWorkouts([w({ status: 'skipped' }), w({ date: '2026-03-10' })])], ['2026-03-10'])
}

// deleted rows are not sessions
{
  assert.equal(dayMarkers([w({ deleted: true }), w({ deleted: true, status: 'skipped' })]).size, 0)
  assert.equal(localDatesWithWorkouts([w({ deleted: true })]).size, 0)
}

// bad or missing date falls back to startedAt; unusable rows are dropped
{
  const late = w({ date: '2026-02-30', startedAt: new Date(2026, 2, 8, 23, 59).getTime() })
  const empty = w({ date: '', startedAt: new Date(2026, 2, 9, 0, 0).getTime() })
  const none = w({ date: '', startedAt: NaN })
  const m = dayMarkers([late, empty, none])
  assert.deepEqual([...m.keys()].sort(), ['2026-03-08', '2026-03-09'])
  assert.equal(late.date, '2026-02-30') // input untouched
}

// from/to are inclusive, across a DST week
{
  const ws = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'].map((date) => w({ date }))
  assert.deepEqual([...dayMarkers(ws, { from: '2026-03-07', to: '2026-03-09' }).keys()], ['2026-03-07', '2026-03-08', '2026-03-09'])
  assert.equal(dayMarkers(ws, { from: '2026-03-09' }).size, 2)
  assert.equal(dayMarkers(ws, { to: '2026-03-06' }).size, 1)
}

console.log('dayMarkers.check: ok')
