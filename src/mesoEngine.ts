import type { LoggedExercise, LoggedSet, Mesocycle, Workout } from './types'
import { MUSCLE_GROUPS } from './types'

export function muscleGroupName(id: number, overrides: Record<number, string> | undefined): string {
  return overrides?.[id] ?? MUSCLE_GROUPS.find((g) => g.id === id)?.name ?? `Muscle ${id}`
}

export interface MesoPosition {
  weekIndex: number
  dayIndex: number
  isDeload: boolean
  isFirstWeek: boolean
}

/** Where the next workout falls in the meso's repeating template, based on how many
 *  workouts have already been logged against it. No calendar constraint — just the
 *  next slot in sequence, whenever the user next trains. */
export function mesoPosition(meso: Mesocycle, workouts: Workout[]): MesoPosition {
  const count = workouts.filter((w) => w.mesoId === meso.id && !w.deleted).length
  const daysPerWeek = Math.max(1, meso.days.length)
  const weekIndex = Math.min(Math.floor(count / daysPerWeek), Math.max(0, meso.weeksPlanned - 1))
  const dayIndex = count % daysPerWeek
  const deloadWeek = meso.deloadWeek ?? meso.weeksPlanned - 1
  return { weekIndex, dayIndex, isDeload: weekIndex === deloadWeek, isFirstWeek: weekIndex === 0 }
}

const WEIGHT_INCREMENT = 5
const DELOAD_FACTOR = 0.6

function lastPerformance(templateExerciseId: string, workouts: Workout[]): LoggedExercise | null {
  for (let i = workouts.length - 1; i >= 0; i--) {
    for (const ex of workouts[i].exercises) {
      if (ex.templateExerciseId === templateExerciseId) return ex
    }
  }
  return null
}

function nextTarget(
  templateExerciseId: string,
  repTarget: [number, number] | undefined,
  sortedWorkouts: Workout[],
  isDeload: boolean,
): { weight: number | null; reps: number | null } {
  const targetReps = repTarget?.[1] ?? repTarget?.[0] ?? null
  const last = lastPerformance(templateExerciseId, sortedWorkouts)
  if (!last) return { weight: null, reps: targetReps }
  const lastWeights = last.sets.map((s) => s.weight).filter((w): w is number => w != null)
  const lastWeight = lastWeights.length ? Math.max(...lastWeights) : null
  if (lastWeight == null) return { weight: null, reps: targetReps }
  if (isDeload) return { weight: Math.round(lastWeight * DELOAD_FACTOR), reps: repTarget?.[0] ?? targetReps }
  const hitAll = targetReps != null && last.sets.every((s) => s.status !== 'skipped' && (s.reps ?? 0) >= targetReps)
  return { weight: hitAll ? lastWeight + WEIGHT_INCREMENT : lastWeight, reps: targetReps }
}

/** Builds the pre-filled exercise list for the next workout in a mesocycle:
 *  no targets in week 1 (nothing to base them on), otherwise "hit target reps
 *  last time -> add weight, else repeat", reduced on the deload week. */
export function generateWorkoutExercises(meso: Mesocycle, position: MesoPosition, allWorkouts: Workout[]): LoggedExercise[] {
  const day = meso.days[position.dayIndex]
  if (!day) return []
  const relevant = allWorkouts.filter((w) => w.mesoId === meso.id && !w.deleted).sort((a, b) => a.startedAt - b.startedAt)
  return day.exercises.map((tex) => {
    const setCount = Math.max(1, tex.sets)
    const sets: LoggedSet[] = Array.from({ length: setCount }, () => {
      if (position.isFirstWeek) return { weight: null, reps: null, done: false }
      const { weight, reps } = nextTarget(tex.id, tex.repTarget, relevant, position.isDeload)
      return { weight: null, reps: null, done: false, weightTarget: weight, repsTarget: reps }
    })
    const exercise: LoggedExercise = {
      id: crypto.randomUUID(),
      name: tex.name,
      sets,
      templateExerciseId: tex.id,
    }
    if (tex.muscleGroupId != null) exercise.muscleGroupId = tex.muscleGroupId
    return exercise
  })
}
