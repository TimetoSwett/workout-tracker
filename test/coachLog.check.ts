// The coach may point at inconsistent old entries, but a change lands only when applied.
// Finishing a workout guesses the next target for every plan exercise from that
// exercise's own history. A bad day for a muscle holds the other lifts of that muscle.
import assert from 'node:assert/strict'
import type { LoggedSet, Mesocycle, Workout } from '../src/types'

const { applyLogEdit, findLogEdits } = require('../src/logReview') as typeof import('../src/logReview')
const { acceptCoachGuesses, guessNextTargets } = require('../src/predictions') as typeof import('../src/predictions')
const { generateWorkoutExercises } = require('../src/mesoEngine') as typeof import('../src/mesoEngine')

function set(weight: number, reps: number): LoggedSet {
  return { weight, reps, done: true }
}

function workout(partial: Pick<Workout, 'id' | 'date' | 'startedAt' | 'exercises'> & Partial<Workout>): Workout {
  return { updatedAt: 0, ...partial }
}

const meso: Mesocycle = {
  id: 'm',
  name: 'Upper',
  unit: 'lbs',
  weeksPlanned: 5,
  deloadWeek: 4,
  days: [
    {
      id: 'sun',
      label: 'Sunday',
      exercises: [
        { id: 'bench', name: 'Bench Press', muscleGroupId: 1, sets: 3, repTarget: [8, 12] },
        { id: 'fly', name: 'Chest Fly', muscleGroupId: 1, sets: 3, repTarget: [10, 12] },
      ],
    },
    {
      id: 'mon',
      label: 'Monday',
      exercises: [
        { id: 'squat', name: 'Squat', muscleGroupId: 6, sets: 3, repTarget: [6, 10] },
        { id: 'curl', name: 'Curl', muscleGroupId: 4, sets: 2, repTarget: [8, 12] },
      ],
    },
  ],
  priorities: [],
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
}

function main() {
  const odd: Workout = workout({
    id: 'w1',
    date: '2026-10-01',
    startedAt: 1,
    exercises: [
      { id: 'a', name: 'Smith Machine Bench-Press', sets: [set(100, 8)] },
      { id: 'b', name: 'Incline Bench Press', sets: [set(80, 8)] },
    ],
  })
  const usual: Workout = workout({
    id: 'w2',
    date: '2026-10-08',
    startedAt: 1,
    exercises: [{ id: 'c', name: 'Smith Machine Bench Press', sets: [set(100, 8), set(100, 8), set(100, 8), set(100, 8), set(500, 8)] }],
  })
  const edits = findLogEdits([odd, usual], ['Smith Machine Bench Press'], 'lbs')
  const rename = edits.find((e) => e.kind === 'rename')
  assert.equal(rename?.from, 'Smith Machine Bench-Press')
  assert.equal(rename?.to, 'Smith Machine Bench Press')
  assert.equal(edits.some((e) => e.from.includes('Incline')), false)
  const heavy = edits.find((e) => e.kind === 'weight')
  assert.equal(heavy?.from, '500')
  assert.equal(heavy?.to, '100')
  const renamed = applyLogEdit(odd, rename!)
  assert.equal(renamed?.exercises[0].name, 'Smith Machine Bench Press')
  assert.equal(renamed?.exercises[1].name, 'Incline Bench Press')
  assert.equal(applyLogEdit(renamed!, rename!), null)

  const fly = workout({
    id: 'fly',
    date: '2026-11-01',
    startedAt: 1,
    exercises: [{ id: 'f', name: 'Chest Fly', muscleGroupId: 1, sets: [set(30, 12), set(30, 12), set(30, 12)] }],
  })
  const squat = workout({
    id: 'sq',
    date: '2026-11-02',
    startedAt: 1,
    exercises: [{ id: 's', name: 'Squat', muscleGroupId: 6, sets: [set(200, 10), set(200, 10), set(200, 10)] }],
  })
  const finished = workout({
    id: 'today',
    date: '2026-11-15',
    startedAt: 5,
    mesoId: 'm',
    exercises: [{ id: 'b', name: 'Bench Press', muscleGroupId: 1, sets: [set(135, 8), set(135, 8)] }],
  })
  const guesses = guessNextTargets({ workouts: [fly, squat, finished], finished, meso, unit: 'lbs' })
  const byName = Object.fromEntries(guesses.map((g) => [g.name, g]))
  assert.equal(byName['Bench Press'].weight, 135)
  assert.equal(byName['Bench Press'].reps, 12)
  assert.equal(byName['Chest Fly'].weight, 30)
  assert.equal(byName['Squat'].weight, 205)
  assert.equal(byName['Curl'].weight, null)
  assert.equal(byName['Curl'].reps, 12)

  const deloadMeso: Mesocycle = {
    ...meso,
    weeksPlanned: 2,
    deloadWeek: 1,
    days: [meso.days[0]],
  }
  const deload = guessNextTargets({
    workouts: [workout({ id: 'old', date: '2026-11-01', startedAt: 1, mesoId: 'm', exercises: [{ id: 'b', name: 'Bench Press', sets: [set(100, 12), set(100, 12), set(100, 12)] }] })],
    finished: workout({ id: 'fin', date: '2026-11-08', startedAt: 2, mesoId: 'm', exercises: [{ id: 'b2', name: 'Bench Press', sets: [set(100, 12), set(100, 12), set(100, 12)] }] }),
    meso: deloadMeso,
    unit: 'lbs',
  })
  assert.equal(deload.find((g) => g.name === 'Bench Press')?.weight, 60)

  const accepted = acceptCoachGuesses(
    '```json\n[{"name":"Bench Press","weight":142,"reps":11},{"name":"Made Up","weight":50,"reps":8},{"name":"Curl","weight":40,"reps":10}]\n```',
    meso.days.flatMap((d) => d.exercises),
    [finished],
  )
  assert.deepEqual(accepted.map((g) => g.name), ['Bench Press'])
  assert.equal(accepted[0].weight, 142.5)
  assert.equal(accepted[0].reps, 11)

  const generated = generateWorkoutExercises(meso, { weekIndex: 0, dayIndex: 0, isDeload: false, isFirstWeek: true }, [], {
    'bench press': { weight: 135, reps: 12 },
  })
  assert.equal(generated[0].sets[0].weightTarget, 135)
  assert.equal(generated[0].sets[0].repsTarget, 12)
  assert.equal(generated[0].sets[0].weight, null)

  console.log('coachLog: ok')
}

main()
