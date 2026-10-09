// A record must come from a set the user actually completed, and an exact tie must not
// depend on the order the sets happen to be stored in. Both were broken (TOM-88 A1/A2/A4),
// and three call sites each had their own eligibility rule (A3).
import assert from 'node:assert/strict'
import type { LoggedSet, Workout } from '../src/types'
const { beatsRecord, estimate1RM, isCompletedSet, isScoringSet, isScoringWorkout, scoringSets } =
  require('../src/records') as typeof import('../src/records')
const { compileHistorySummary, compileWorkouts } = require('../src/prompts') as typeof import('../src/prompts')

const settings = { units: 'lbs', restSeconds: 120, philosophy: 'balanced' } as const
const workout = (date: string, sets: LoggedSet[], extra: Partial<Workout> = {}): Workout => ({
  id: `w-${date}-${Math.random()}`,
  date,
  startedAt: Date.parse(`${date}T10:00:00Z`),
  updatedAt: 0,
  exercises: [{ id: 'e1', name: 'Squat', sets }],
  ...extra,
})

function main() {
  let n = 0
  const check = (fn: () => void) => { fn(); n++ }

  // --- completion ---------------------------------------------------------------
  // `done` is the only flag the Log flow writes, and finishing a workout keeps any row
  // with numbers typed into it, so an un-ticked row must not count as performed.
  check(() => assert.equal(isCompletedSet({ weight: 225, reps: 5, done: true }), true))
  check(() => assert.equal(isCompletedSet({ weight: 225, reps: 5, done: false }), false))
  check(() => assert.equal(isCompletedSet({ weight: 225, reps: 5 }), false, 'a set with no done flag is not completed'))
  check(() => assert.equal(isCompletedSet({ weight: 225, reps: 5, done: true, status: 'complete' }), true))
  check(() => assert.equal(isCompletedSet({ weight: 225, reps: 5, done: true, status: 'skipped' }), false))
  // `mapSetStatus` gives every unrecognised upstream status 'pending', so an imported but
  // unperformed plan row lands here and must never score.
  check(() => assert.equal(isCompletedSet({ weight: 300, reps: 5, done: true, status: 'pending' }), false))

  // --- record eligibility ------------------------------------------------------
  check(() => assert.equal(isScoringSet({ weight: 225, reps: 5, done: true }), true))
  check(() => assert.equal(isScoringSet({ weight: null, reps: 10, done: true }), false, 'no load, so no 1RM'))
  check(() => assert.equal(isScoringSet({ weight: 0, reps: 10, done: true }), false, 'a 0lb set estimates to 0'))
  check(() => assert.equal(isScoringSet({ weight: 225, reps: null, done: true }), false))
  check(() => assert.equal(isScoringSet({ weight: 225, reps: 0, done: true }), false))

  check(() => assert.equal(isScoringWorkout(workout('2026-01-01', [])), true))
  check(() => assert.equal(isScoringWorkout(workout('2026-01-01', [], { status: 'skipped' })), false))
  check(() => assert.equal(isScoringWorkout(workout('2026-01-01', [], { deleted: true })), false))
  check(() => assert.equal(isScoringWorkout(workout('2026-01-01', [], { status: 'partial' })), true))

  // A skipped session contributes nothing even though its rows kept their numbers.
  check(() =>
    assert.deepEqual(
      [...scoringSets([
        workout('2026-01-01', [{ weight: 100, reps: 5, done: true }, { weight: 999, reps: 5, done: false }]),
        workout('2026-01-02', [{ weight: 500, reps: 5, done: true }], { status: 'skipped' }),
      ])].map((s) => s.set.weight),
      [100],
    ),
  )

  // --- tiebreak ----------------------------------------------------------------
  // 300x5 and 250x12 are both exactly 350. The record belongs to the day it was first hit,
  // whichever order a Dropbox merge left the array in.
  const heavy = { weight: 300, reps: 5, e1rm: estimate1RM(300, 5), date: '2026-09-20' }
  const reppy = { weight: 250, reps: 12, e1rm: estimate1RM(250, 12), date: '2026-09-27' }
  check(() => assert.equal(heavy.e1rm, reppy.e1rm, 'the seeded tie is an exact float tie'))
  check(() => assert.equal(beatsRecord(heavy, reppy), true, 'earlier date takes an exact tie'))
  check(() => assert.equal(beatsRecord(reppy, heavy), false, 'and does so from either direction'))
  check(() => assert.equal(beatsRecord(heavy, undefined), true))
  // Same day, same estimate: the heavier set is the measured half, so it wins.
  check(() => assert.equal(beatsRecord({ ...heavy, date: '2026-09-27' }, reppy), true))
  check(() => assert.equal(beatsRecord({ ...reppy, date: '2026-09-20' }, heavy), false))
  // This comparator ranks by estimate alone: 350x8 outranks 400x1 even though 400 is the
  // heavier bar. Reporting the heaviest weight lifted is a separate figure (TOM-43 AC1),
  // not something a 1RM comparator can answer.
  const maxWeight = { weight: 400, reps: 1, e1rm: estimate1RM(400, 1), date: '2026-09-20' }
  const maxEstimate = { weight: 350, reps: 8, e1rm: estimate1RM(350, 8), date: '2026-09-27' }
  check(() => assert.equal(beatsRecord(maxEstimate, maxWeight), true))
  check(() => assert.equal(beatsRecord(maxWeight, maxEstimate), false))

  // --- the coach is told the same thing the board is shown ---------------------
  const history = [
    workout('2026-09-20', [{ weight: 300, reps: 5, done: true }]),
    workout('2026-09-27', [{ weight: 250, reps: 12, done: true }, { weight: 999, reps: 5, done: false }]),
  ]
  const forward = compileHistorySummary(history, settings as never)
  const reversed = compileHistorySummary([...history].reverse(), settings as never)
  check(() => assert.match(forward, /Squat: 350lbs \(300x5 on 2026-09-20\)/))
  check(() => assert.ok(!forward.includes('999'), 'an un-completed set is not an all-time max'))
  check(() => assert.equal(
    forward.split('# ALL-TIME BEST')[1],
    reversed.split('# ALL-TIME BEST')[1],
    'all-time bests do not depend on stored workout order',
  ))

  // --- LOAD TRENDS obeys session eligibility too (TOM-90 finding) --------------
  // A skipped session keeps whatever load was prescribed for it, and its rows can carry
  // `done: true` from the plan import. The trend block read those rows directly, so a
  // 900x5 the board never touched became the far end of the trend line the coach reasons
  // from, while History — which already filtered the session out — showed 117lbs.
  const skippedTail = [
    workout('2026-09-20', [{ weight: 100, reps: 5, done: true }]),
    workout('2026-09-27', [{ weight: 900, reps: 5, done: true }], { status: 'skipped' }),
  ]
  const skippedOut = compileWorkouts(skippedTail, settings as never)
  check(() => assert.ok(!skippedOut.includes('1050'), 'a skipped session does not end the trend line'))
  check(() => assert.ok(!/# LOAD TRENDS/.test(skippedOut), 'one eligible session is not a trend'))
  // Same shape, tombstoned instead of skipped.
  const deletedTail = [
    workout('2026-09-20', [{ weight: 100, reps: 5, done: true }]),
    workout('2026-09-27', [{ weight: 900, reps: 5, done: true }], { deleted: true }),
  ]
  check(() => assert.ok(!compileWorkouts(deletedTail, settings as never).includes('1050')))
  // An un-ticked row inside an eligible session is excluded by the set rule, as before.
  const untickedTail = [
    workout('2026-09-20', [{ weight: 100, reps: 5, done: true }]),
    workout('2026-09-27', [{ weight: 900, reps: 5, done: false }]),
  ]
  check(() => assert.ok(!compileWorkouts(untickedTail, settings as never).includes('1050')))
  // And a real progression still reports, so the gate did not silence the feature.
  const realTrend = compileWorkouts(
    [
      workout('2026-09-20', [{ weight: 100, reps: 5, done: true }]),
      workout('2026-09-27', [{ weight: 200, reps: 5, done: true }], { status: 'partial' }),
    ],
    settings as never,
  )
  check(() => assert.match(realTrend, /Squat: est 1RM 117 → 233 lbs \(100x5 → 200x5\)/))

  console.log(`${n}/${n} record eligibility and tiebreak checks passed`)
}

main()
