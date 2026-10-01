/** Round-trip checks for the synced weight representation (`src/weightWire.ts`).
 *
 *  These cover the defect QA found: a 140 lbs workout reached a second phone as 63.5 and
 *  was shown as "63.5 lbs". Every sender/receiver unit pairing is exercised for both synced
 *  weight-bearing shapes, plus the untagged-legacy reading and the precision guarantee the
 *  wire format depends on.
 *
 *  Run with `npm run check`. */
import type { DailyMetric, Workout } from '../src/types'
import type { Units } from '../src/units'
import { convertWeight, convertWeightExact } from '../src/units'
import {
  WIRE_UNIT,
  decodeMetric,
  decodeWorkout,
  encodeMetric,
  encodeWorkout,
  hasUntaggedRecords,
} from '../src/weightWire'
import type { WireMetric, WireWorkout } from '../src/weightWire'

const UNITS: Units[] = ['lbs', 'kg']

let failures = 0
let checks = 0

function check(name: string, fn: () => void) {
  checks++
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`)
  }
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

/** Weights are stored and shown to 0.1, so that is the tolerance a receiver is held to. */
function near(actual: number | null | undefined, expected: number, what: string) {
  if (actual == null || Math.abs(actual - expected) > 0.05) {
    throw new Error(`${what}: expected ~${expected}, got ${actual}`)
  }
}

function workout(weights: { weight: number; target: number }, bodyweight: number): Workout {
  return {
    id: 'w1',
    date: '2026-09-28',
    startedAt: 1_759_000_000_000,
    updatedAt: 1_759_000_100_000,
    name: 'Push A',
    notes: 'felt strong',
    exercises: [
      {
        id: 'e1',
        name: 'Bench Press',
        muscleGroupId: 1,
        sets: [
          { weight: weights.weight, reps: 8, done: true, weightTarget: weights.target, repsTarget: 8 },
          { weight: null, reps: null },
        ],
      },
    ],
    bodyweight,
  }
}

function metric(values: { weight: number; muscle: number; leanMass: number }): DailyMetric {
  return {
    date: '2026-09-28',
    weight: values.weight,
    bodyFat: 18.2,
    muscle: values.muscle,
    leanMass: values.leanMass,
    steps: 9120,
    sleepMin: 431,
    restingHr: 54,
    calories: 2480,
    proteinG: 180,
    updatedAt: 1_759_000_100_000,
    source: 'manual',
  }
}

/** The same physical weight written out in each unit, so a receiver's expected reading is
 *  stated independently of the conversion the code under test performs. */
const BENCH = { lbs: 140, kg: 63.5 }
const TARGET = { lbs: 145.1, kg: 65.8 }
const BODY = { lbs: 178.4, kg: 80.9 }
const MUSCLE = { lbs: 80.2, kg: 36.4 }
const LEAN = { lbs: 150.1, kg: 68.1 }

console.log('\nfixtures')
check('each fixture pair is the same weight to the 0.1 the app stores', () => {
  // Otherwise a pairing that is merely close would make the receiver assertions below
  // pass or fail on how the fixture was rounded rather than on the conversion.
  for (const [name, pair] of Object.entries({ BENCH, TARGET, BODY, MUSCLE, LEAN })) {
    eq(convertWeight(pair.lbs, 'lbs', 'kg'), pair.kg, `${name} lbs -> kg`)
    eq(convertWeight(pair.kg, 'kg', 'lbs'), pair.lbs, `${name} kg -> lbs`)
  }
})

console.log('\nworkouts: every sender/receiver unit pairing')
for (const sender of UNITS) {
  for (const receiver of UNITS) {
    check(`${sender} sender -> ${receiver} receiver`, () => {
      const wire = encodeWorkout(workout({ weight: BENCH[sender], target: TARGET[sender] }, BODY[sender]), sender)
      eq(wire.weightUnit, WIRE_UNIT, 'wire records its unit')

      const got = decodeWorkout(JSON.parse(JSON.stringify(wire)) as WireWorkout, receiver)
      const set = got.exercises[0].sets[0]
      near(set.weight, BENCH[receiver], 'set weight')
      near(set.weightTarget, TARGET[receiver], 'set target')
      near(got.bodyweight, BODY[receiver], 'bodyweight')

      // Everything that is not a weight survives untouched, and the wire-only tag does
      // not leak into local storage.
      eq('weightUnit' in got, false, 'tag stripped on decode')
      eq(got.exercises[0].sets[1], { weight: null, reps: null }, 'empty set unchanged')
      eq({ id: got.id, name: got.name, notes: got.notes, updatedAt: got.updatedAt },
         { id: 'w1', name: 'Push A', notes: 'felt strong', updatedAt: 1_759_000_100_000 },
         'non-weight fields')
    })
  }
}

console.log('\nbody metrics: every sender/receiver unit pairing')
for (const sender of UNITS) {
  for (const receiver of UNITS) {
    check(`${sender} sender -> ${receiver} receiver`, () => {
      const wire = encodeMetric(metric({ weight: BENCH[sender], muscle: MUSCLE[sender], leanMass: LEAN[sender] }), sender)
      eq(wire.weightUnit, WIRE_UNIT, 'wire records its unit')

      const got = decodeMetric(JSON.parse(JSON.stringify(wire)) as WireMetric, receiver)
      near(got.weight, BENCH[receiver], 'weight')
      near(got.muscle, MUSCLE[receiver], 'muscle')
      near(got.leanMass, LEAN[receiver], 'lean mass')

      // Percentages, counts and minutes are unit-free and must not be converted.
      eq({ bodyFat: got.bodyFat, steps: got.steps, sleepMin: got.sleepMin, restingHr: got.restingHr,
           calories: got.calories, proteinG: got.proteinG, source: got.source },
         { bodyFat: 18.2, steps: 9120, sleepMin: 431, restingHr: 54,
           calories: 2480, proteinG: 180, source: 'manual' },
         'unit-free fields')
      eq('weightUnit' in got, false, 'tag stripped on decode')
    })
  }
}

console.log('\nthe defect QA reported')
check('a lbs phone that switches to kg no longer pushes "63.5 lbs" to the other phone', () => {
  // Phone A logs 140 lbs, then the board switches A to kg: `convertStoredWeights` rewrites
  // A's own storage to 63.5 kg and bumps `updatedAt`, so A's record wins the merge.
  const beforeSwitch = workout({ weight: 140, target: 145 }, 178.4)
  const afterSwitch: Workout = {
    ...beforeSwitch,
    updatedAt: beforeSwitch.updatedAt + 1,
    bodyweight: convertWeight(beforeSwitch.bodyweight!, 'lbs', 'kg'),
    exercises: beforeSwitch.exercises.map((ex) => ({
      ...ex,
      sets: ex.sets.map((s) => ({
        ...s,
        weight: s.weight == null ? s.weight : convertWeight(s.weight, 'lbs', 'kg'),
        weightTarget: s.weightTarget == null ? s.weightTarget : convertWeight(s.weightTarget, 'lbs', 'kg'),
      })),
    })),
  }
  near(afterSwitch.exercises[0].sets[0].weight, 63.5, 'phone A now stores kg')

  // Phone B is still in lbs. It must read 140 lbs, not 63.5.
  const onB = decodeWorkout(encodeWorkout(afterSwitch, 'kg'), 'lbs')
  near(onB.exercises[0].sets[0].weight, 140, 'phone B reads the bench back in lbs')
  near(onB.bodyweight, 178.4, 'phone B reads bodyweight back in lbs')
})

console.log('\nlegacy records written before weights were tagged')
check('an untagged record is read as the receiving device\'s own units', () => {
  // Documented behaviour: nothing in the payload says what an untagged number means, so it
  // is read as the receiver's unit. That is what the app did before tagging, so a board
  // that has only ever used one unit is unaffected.
  const legacy = { ...workout({ weight: 140, target: 145 }, 178.4) } as WireWorkout
  eq('weightUnit' in legacy, false, 'fixture really is untagged')
  for (const receiver of UNITS) {
    const got = decodeWorkout(legacy, receiver)
    near(got.exercises[0].sets[0].weight, 140, `read verbatim on a ${receiver} device`)
    near(got.bodyweight, 178.4, `bodyweight read verbatim on a ${receiver} device`)
  }
  const legacyMetric = { ...metric({ weight: 178.4, muscle: 80.2, leanMass: 150.1 }) } as WireMetric
  for (const receiver of UNITS) {
    near(decodeMetric(legacyMetric, receiver).weight, 178.4, `metric read verbatim on a ${receiver} device`)
  }
})

check('untagged records are detected, so sync can re-upload and stop the ambiguity', () => {
  eq(hasUntaggedRecords([]), false, 'empty remote')
  eq(hasUntaggedRecords([encodeWorkout(workout({ weight: 140, target: 145 }, 178.4), 'lbs')]), false, 'all tagged')
  eq(hasUntaggedRecords([{ ...workout({ weight: 140, target: 145 }, 178.4) } as WireWorkout]), true, 'one untagged')
  eq(
    hasUntaggedRecords([
      encodeWorkout(workout({ weight: 140, target: 145 }, 178.4), 'lbs'),
      { ...workout({ weight: 140, target: 145 }, 178.4) } as WireWorkout,
    ]),
    true,
    'mixed remote',
  )
  // Reading an untagged record promotes the device's reading to a real tag, so the guess
  // is made once rather than on every sync.
  const promoted = encodeWorkout(decodeWorkout({ ...workout({ weight: 140, target: 145 }, 178.4) } as WireWorkout, 'lbs'), 'lbs')
  eq(promoted.weightUnit, WIRE_UNIT, 'now tagged')
  eq(hasUntaggedRecords([promoted]), false, 'and no longer ambiguous')
})

console.log('\nprecision: the wire value must not walk on repeated sync')
check('local -> wire -> local returns the stored number for both units', () => {
  // Rounding on upload is what would make this drift, so these are values whose kg
  // equivalent does not land on a tenth.
  for (const local of UNITS) {
    for (const v of [137.5, 140, 62.4, 2.5, 0.1, 405.5, 178.4, 63.5]) {
      const back = decodeWorkout(encodeWorkout(workout({ weight: v, target: v }, v), local), local)
      eq(back.exercises[0].sets[0].weight, v, `${v} ${local} round trip`)
      eq(back.bodyweight, v, `${v} ${local} bodyweight round trip`)
      eq(decodeMetric(encodeMetric(metric({ weight: v, muscle: v, leanMass: v }), local), local).weight, v,
         `${v} ${local} metric round trip`)
    }
  }
})

check('a cross-unit record settles instead of drifting further each sync', () => {
  // A kg phone stores the lbs phone's bench rounded to 0.1 kg and may re-upload that
  // rounded value. The reading on the lbs phone must stay put from then on, not creep.
  let onKg = decodeWorkout(encodeWorkout(workout({ weight: 137.5, target: 137.5 }, 137.5), 'lbs'), 'kg')
  const first = decodeWorkout(encodeWorkout(onKg, 'kg'), 'lbs').exercises[0].sets[0].weight!
  for (let i = 0; i < 20; i++) {
    const onLbs = decodeWorkout(encodeWorkout(onKg, 'kg'), 'lbs')
    eq(onLbs.exercises[0].sets[0].weight, first, `lbs reading stable after ${i + 1} further round trips`)
    onKg = decodeWorkout(encodeWorkout(onLbs, 'lbs'), 'kg')
  }
  // 137.5 lbs is 62.36895 kg; the kg phone stores 62.4, which reads back as 137.6. One
  // display tenth is the whole cost of a record crossing units, and it is paid once.
  if (Math.abs(first - 137.5) > 0.1) {
    throw new Error(`settled reading moved more than a display tenth: ${first}`)
  }
})

console.log('\nlocal/offline unit switching still converts (regression guard for D6)')
check('convertWeight and convertWeightExact agree on direction and rounding', () => {
  eq(convertWeight(140, 'lbs', 'kg'), 63.5, '140 lbs is 63.5 kg')
  eq(convertWeight(63.5, 'kg', 'lbs'), 140, '63.5 kg is 140 lbs')
  eq(convertWeight(140, 'lbs', 'lbs'), 140, 'same unit is a no-op')
  eq(convertWeight(0.45, 'kg', 'lbs', 2), 0.99, 'the goal rate keeps two decimals')
  eq(convertWeightExact(140, 'lbs', 'lbs'), 140, 'exact same-unit is a no-op')
  if (convertWeightExact(140, 'lbs', 'kg') === convertWeight(140, 'lbs', 'kg')) {
    throw new Error('convertWeightExact must not round — the wire format depends on it')
  }
  near(convertWeightExact(140, 'lbs', 'kg'), 63.5, 'exact conversion is still the right magnitude')
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
