// An imported meso can be reused as a new plan without inheriting its workouts,
// and the log calendar reads local days without inventing a session.
import assert from 'node:assert/strict'
import type { Mesocycle, Workout } from '../src/types'
const { cloneMesoAsTemplate } = require('../src/mesoClone') as typeof import('../src/mesoClone')
const { commitPastEdit, localDatesWithWorkouts, monthGrid, workoutsOnLocalDate } =
  require('../src/calendar') as typeof import('../src/calendar')
const { generateWorkoutExercises } = require('../src/mesoEngine') as typeof import('../src/mesoEngine')

function ids() {
  let n = 0
  return () => `new-${++n}`
}

function source(): Mesocycle {
  return {
    id: 'rp-1',
    name: 'Upper Lower',
    unit: 'lbs',
    weeksPlanned: 5,
    deloadWeek: 4,
    days: [
      {
        id: 'rp-day-1',
        label: 'Upper',
        exercises: [{ id: 'rp-tex-bench', name: 'Bench Press', muscleGroupId: 1, sets: 3, repTarget: [8, 12] }],
      },
    ],
    priorities: [{ muscleGroupId: 1, type: 'grow' }],
    status: 'complete',
    createdAt: 1,
    finishedAt: 2,
    updatedAt: 3,
    imported: true,
    goal: 'grow',
  }
}

const workout = (id: string, date: string, startedAt: number, extra: Partial<Workout> = {}): Workout => ({
  id,
  date,
  startedAt,
  updatedAt: startedAt,
  exercises: [],
  ...extra,
})

function main() {
  let n = 0
  const check = (fn: () => void) => { fn(); n++ }

  check(() => {
    const original = source()
    const snapshot = JSON.stringify(original)
    const copy = cloneMesoAsTemplate(original, 50, ids())
    copy.days[0].exercises[0].name = 'Changed'
    copy.days[0].label = 'Changed day'
    copy.priorities[0].type = 'maintain'
    assert.equal(JSON.stringify(original), snapshot)
    assert.equal(copy.id, 'new-1')
    assert.equal(copy.days[0].id, 'new-2')
    assert.equal(copy.days[0].exercises[0].id, 'new-3')
    assert.notEqual(copy.days[0].exercises[0].id, original.days[0].exercises[0].id)
    assert.equal(copy.status, 'active')
    assert.equal(copy.imported, false)
    assert.equal(copy.finishedAt, undefined)
    assert.equal(copy.createdAt, 50)
    assert.equal(copy.name, 'Upper Lower')
    assert.equal(copy.unit, 'lbs')
    assert.equal(copy.weeksPlanned, 5)
    assert.equal(copy.deloadWeek, 4)
    assert.deepEqual(copy.days[0].exercises[0].repTarget, [8, 12])
    assert.equal(copy.goal, 'grow')
  })

  check(() => {
    const original = source()
    const copy = cloneMesoAsTemplate(original, 50, ids())
    const old: Workout = {
      id: 'logged',
      date: '2026-09-01',
      startedAt: 1,
      updatedAt: 1,
      mesoId: original.id,
      exercises: [
        {
          id: 'ex',
          name: 'Bench Press',
          templateExerciseId: original.days[0].exercises[0].id,
          sets: [
            { weight: 200, reps: 10, done: true },
            { weight: 200, reps: 10, done: true },
            { weight: 200, reps: 10, done: true },
          ],
        },
      ],
    }
    const generated = generateWorkoutExercises(
      copy,
      { weekIndex: 1, dayIndex: 0, isDeload: false, isFirstWeek: false },
      [old],
    )
    assert.equal(generated[0].sets[0].weightTarget ?? null, null)
    assert.notEqual(generated[0].templateExerciseId, 'rp-tex-bench')
  })

  check(() => {
    const sessions = [
      workout('later', '2026-10-16', 20, { name: 'Evening' }),
      workout('other', '2026-10-15', 5),
      workout('gone', '2026-10-16', 1, { deleted: true }),
      workout('earlier', '2026-10-16', 10, { name: 'Morning' }),
    ]
    assert.deepEqual(
      workoutsOnLocalDate(sessions, '2026-10-16').map((w) => w.id),
      ['earlier', 'later'],
    )
    assert.deepEqual(workoutsOnLocalDate(sessions, '2026-10-17'), [])
    assert.equal(localDatesWithWorkouts(sessions).has('2026-10-16'), true)
    assert.equal(localDatesWithWorkouts(sessions).has('2026-10-17'), false)
  })

  check(() => {
    const oct = monthGrid(2026, 9)
    const inMonth = oct.filter((c) => c.inMonth)
    assert.equal(inMonth[0].date, '2026-10-01')
    assert.equal(inMonth[inMonth.length - 1].date, '2026-10-31')
    assert.equal(inMonth.length, 31)
    assert.equal(oct.length % 7, 0)
    assert.equal(oct[0].date < '2026-10-01', true)
    const nov = monthGrid(2026, 10)
    const novDays = nov.filter((c) => c.inMonth)
    assert.equal(novDays[0].date, '2026-11-01')
    assert.equal(novDays[novDays.length - 1].date, '2026-11-30')
  })

  check(() => {
    const original = workout('w1', '2026-10-01', 10, { name: 'Push' })
    const active = workout('open', '2026-10-17', 99, { name: 'Today' })
    const snapshot = JSON.stringify(original)
    const activeSnapshot = JSON.stringify(active)
    const saved = commitPastEdit(original, { ...original, name: 'Push edited', date: '2026-10-17', id: 'open' }, 80)
    assert.equal(JSON.stringify(original), snapshot)
    assert.equal(JSON.stringify(active), activeSnapshot)
    assert.equal(saved.id, 'w1')
    assert.equal(saved.date, '2026-10-01')
    assert.equal(saved.startedAt, 10)
    assert.equal(saved.name, 'Push edited')
    assert.equal(saved.updatedAt, 80)
  })

  console.log(`mesoCalendar: ${n} checks passed`)
}

main()
