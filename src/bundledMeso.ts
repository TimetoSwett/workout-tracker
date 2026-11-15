import type { Mesocycle, MesoTemplateDay, MesoTemplateExercise } from './types'

/** Stable id so opening the app again does not add a second copy. */
export const UPPER_HYPERTROPHY_ID = 'meso-upper-hypertrophy-2026-11-15'

const START = '2026-11-15'
/** Sunday through Friday. Saturday is off. 0 = Sunday. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5]

function exercise(id: string, name: string, muscleGroupId: number, sets: number, repTarget: [number, number]): MesoTemplateExercise {
  return { id, name, muscleGroupId, sets, repTarget }
}

const days: MesoTemplateDay[] = [
  {
    id: 'uh-day-sun',
    label: 'Sunday — Press + Pull',
    exercises: [
      exercise('uh-smith-bench', 'Smith Machine Bench Press', 1, 4, [4, 8]),
      exercise('uh-bb-skull-sun', 'Barbell Skullcrusher', 3, 3, [10, 15]),
      exercise('uh-preacher-sun', 'Machine Preacher Curl', 4, 3, [6, 10]),
      exercise('uh-pulldown', 'Pulldown (Normal Grip)', 2, 3, [8, 12]),
    ],
  },
  {
    id: 'uh-day-mon',
    label: 'Monday — Legs (Maintenance)',
    exercises: [
      exercise('uh-leg-press', 'Leg Press', 6, 3, [6, 10]),
      exercise('uh-curl-mon', 'Seated Leg Curl', 8, 3, [8, 12]),
      exercise('uh-calf-mon', 'Calf Machine', 9, 3, [12, 18]),
    ],
  },
  {
    id: 'uh-day-tue',
    label: 'Tuesday — Press + Triceps',
    exercises: [
      exercise('uh-db-bench', 'Dumbbell Bench Press', 1, 4, [8, 12]),
      exercise('uh-db-skull', 'Dumbbell Skull Crusher', 3, 3, [10, 15]),
      exercise('uh-shrug', 'Barbell Shrug', 10, 3, [12, 20]),
    ],
  },
  {
    id: 'uh-day-wed',
    label: 'Wednesday — Delts + Legs',
    exercises: [
      exercise('uh-ohp-wed', 'Smith Machine Shoulder Press (Seated)', 5, 2, [8, 12]),
      exercise('uh-sldl', 'Stiff-Legged Deadlift', 8, 3, [8, 12]),
      exercise('uh-calf-wed', 'Calf Machine', 9, 3, [12, 18]),
    ],
  },
  {
    id: 'uh-day-thu',
    label: 'Thursday — Triceps + Delts',
    exercises: [
      exercise('uh-bb-skull-thu', 'Barbell Skullcrusher', 3, 3, [10, 15]),
      exercise('uh-ohp-thu', 'Smith Machine Shoulder Press (Seated)', 5, 2, [8, 12]),
      exercise('uh-leg-ext', 'Leg Extension', 6, 3, [8, 12]),
    ],
  },
  {
    id: 'uh-day-fri',
    label: 'Friday — Arms + Legs',
    exercises: [
      exercise('uh-preacher-fri', 'Machine Preacher Curl', 4, 3, [6, 10]),
      exercise('uh-curl-fri', 'Seated Leg Curl', 8, 3, [8, 12]),
      exercise('uh-calf-fri', 'Calf Machine', 9, 3, [12, 18]),
    ],
  },
]

export function upperHypertrophyMeso(now: number): Mesocycle {
  return {
    id: UPPER_HYPERTROPHY_ID,
    name: 'Upper Hypertrophy',
    unit: 'lbs',
    weeksPlanned: 5,
    deloadWeek: 4,
    startDate: START,
    trainingWeekdays: WEEKDAYS,
    days,
    priorities: [
      { muscleGroupId: 1, type: 'emphasize' },
      { muscleGroupId: 3, type: 'grow' },
      { muscleGroupId: 4, type: 'grow' },
      { muscleGroupId: 5, type: 'grow' },
      { muscleGroupId: 10, type: 'grow' },
      { muscleGroupId: 6, type: 'maintain' },
      { muscleGroupId: 8, type: 'maintain' },
      { muscleGroupId: 9, type: 'maintain' },
      { muscleGroupId: 2, type: 'maintain' },
    ],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    goal: 'Hypertrophy block emphasizing chest with bench 2x/week; grow triceps, biceps, side delts, and traps; maintain legs and pull, 6 days/week.',
  }
}

/** Adds the plan once. A record with this id, including a deleted one, is left alone.
 *  Any other active plan that is not an import is marked complete, same as saving a new plan.
 *  Returns null when nothing should change. */
export function insertUpperHypertrophy(mesos: Mesocycle[], now: number): Mesocycle[] | null {
  if (mesos.some((m) => m.id === UPPER_HYPERTROPHY_ID)) return null
  const retired = mesos.map((m) =>
    m.status === 'active' && !m.imported
      ? { ...m, status: 'complete' as const, finishedAt: now, updatedAt: now }
      : m,
  )
  return [...retired, upperHypertrophyMeso(now)]
}
