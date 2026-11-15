import type { Mesocycle, MesoTemplateExercise, Workout } from './types'
import { deloadWeekOf, mesoPosition } from './mesoEngine'
import { isCompletedSet, isScoringWorkout } from './records'

export interface TargetGuess {
  name: string
  weight: number | null
  reps: number | null
}

const PLATE = 2.5
const DELOAD = 0.6

function norm(name: string): string {
  return name.trim().toLowerCase()
}

function roundPlate(weight: number): number {
  return Math.round(weight / PLATE) * PLATE
}

function increment(unit: 'lbs' | 'kg'): number {
  return unit === 'kg' ? 2.5 : 5
}

interface Performed {
  weight: number
  reps: number[]
}

function performed(ex: Workout['exercises'][number]): Performed | null {
  if (ex.skipReason) return null
  const sets = ex.sets.filter((s) => isCompletedSet(s) && s.weight != null && s.weight > 0)
  if (sets.length === 0) return null
  return {
    weight: Math.max(...sets.map((s) => s.weight as number)),
    reps: sets.map((s) => s.reps ?? 0),
  }
}

/** Newest completed session of this exact exercise name. */
function lastPerformed(workouts: Workout[], name: string): Performed | null {
  const key = norm(name)
  const ordered = workouts.filter(isScoringWorkout).sort((a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt)
  for (const w of ordered) {
    for (const ex of w.exercises) {
      if (norm(ex.name) !== key) continue
      const done = performed(ex)
      if (done) return done
    }
  }
  return null
}

function repGoal(ex: MesoTemplateExercise, last: Performed | null): number | null {
  if (ex.repTarget) return ex.repTarget[1]
  if (!last || last.reps.length === 0) return null
  return Math.max(...last.reps)
}

function earnedIncrease(last: Performed, plannedSets: number, goal: number): boolean {
  return last.reps.length >= Math.max(1, plannedSets) && last.reps.every((r) => r >= goal)
}

/** True when the next time this exercise appears on the plan is a deload week. */
export function nextAppearanceIsDeload(meso: Mesocycle, workouts: Workout[], name: string): boolean {
  const days = meso.days.length
  if (days === 0) return false
  const start = mesoPosition(meso, workouts)
  const key = norm(name)
  for (let step = 0; step < days * meso.weeksPlanned; step++) {
    const index = start.weekIndex * days + start.dayIndex + step
    const week = Math.floor(index / days)
    if (week >= meso.weeksPlanned) break
    const day = meso.days[index % days]
    if (day?.exercises.some((ex) => norm(ex.name) === key)) return week === deloadWeekOf(meso)
  }
  return false
}

/** Every plan exercise, plus any extra lift in the workout that just finished. */
export function exercisesToGuess(meso: Mesocycle | null, finished: Workout | null): MesoTemplateExercise[] {
  const out: MesoTemplateExercise[] = []
  const seen = new Set<string>()
  if (meso) {
    for (const day of meso.days) {
      for (const ex of day.exercises) {
        const key = norm(ex.name)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(ex)
      }
    }
  }
  for (const ex of finished?.exercises ?? []) {
    const key = norm(ex.name)
    if (!key || seen.has(key) || ex.skipReason) continue
    seen.add(key)
    out.push({
      id: ex.id,
      name: ex.name.trim(),
      muscleGroupId: ex.muscleGroupId,
      sets: Math.max(1, ex.sets.length),
    })
  }
  return out
}

function muscleId(name: string, plan: MesoTemplateExercise[], finished: Workout | null): number | undefined {
  return (
    plan.find((ex) => norm(ex.name) === norm(name))?.muscleGroupId ??
    finished?.exercises.find((ex) => norm(ex.name) === norm(name))?.muscleGroupId
  )
}

/** 'miss' when this muscle was trained and a lift of it did not clear its rep goal. */
function muscleMissed(finished: Workout, muscle: number, plan: MesoTemplateExercise[]): boolean {
  for (const ex of finished.exercises) {
    if (muscleId(ex.name, plan, finished) !== muscle) continue
    const done = performed(ex)
    if (!done) continue
    const planned = plan.find((p) => norm(p.name) === norm(ex.name))
    const goal = planned?.repTarget?.[1]
    if (goal != null && done.reps.some((r) => r < goal)) return true
  }
  return false
}

export function guessNextTargets(input: {
  workouts: Workout[]
  finished: Workout | null
  meso: Mesocycle | null
  unit: 'lbs' | 'kg'
}): TargetGuess[] {
  const list = input.finished && !input.workouts.some((w) => w.id === input.finished!.id)
    ? [...input.workouts, input.finished]
    : input.workouts
  const plan = exercisesToGuess(input.meso, input.finished)
  const guesses: TargetGuess[] = []
  for (const ex of plan) {
    const last = lastPerformed(list, ex.name)
    const goal = repGoal(ex, last)
    if (!last) {
      if (goal != null) guesses.push({ name: ex.name.trim(), weight: null, reps: goal })
      continue
    }
    const muscle = muscleId(ex.name, plan, input.finished)
    const blocked = input.finished != null && muscle != null && muscleMissed(input.finished, muscle, plan)
    const deload = input.meso != null && nextAppearanceIsDeload(input.meso, list, ex.name)
    let weight = last.weight
    if (deload) weight = roundPlate(last.weight * DELOAD)
    else if (!blocked && goal != null && earnedIncrease(last, ex.sets, goal)) weight = roundPlate(last.weight + increment(input.unit))
    guesses.push({ name: ex.name.trim(), weight, reps: goal })
  }
  return guesses
}

export function guessesToMap(guesses: TargetGuess[]): Record<string, TargetGuess> {
  const map: Record<string, TargetGuess> = {}
  for (const g of guesses) map[norm(g.name)] = g
  return map
}

/** Stored guesses win. A live guess fills any exercise the coach has not set yet. */
export function mergeGuesses(live: TargetGuess[], stored: Record<string, { weight: number | null; reps: number | null }>): Record<string, { weight: number | null; reps: number | null }> {
  const map: Record<string, { weight: number | null; reps: number | null }> = {}
  for (const g of live) map[norm(g.name)] = { weight: g.weight, reps: g.reps }
  for (const [key, value] of Object.entries(stored)) map[key] = { weight: value.weight, reps: value.reps }
  return map
}

function lastWeightOf(workouts: Workout[], name: string): number | null {
  return lastPerformed(workouts, name)?.weight ?? null
}

/** Keeps a coach reply only when it names a real plan exercise and stays close to
 *  the weight already logged for that same exercise. No history means no invented weight. */
export function acceptCoachGuesses(reply: string, plan: { name: string }[], workouts: Workout[]): TargetGuess[] {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1] : reply
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const guesses: TargetGuess[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { name?: unknown; weight?: unknown; reps?: unknown }
    if (typeof rec.name !== 'string') continue
    const planned = plan.find((ex) => norm(ex.name) === norm(rec.name as string))
    if (!planned) continue
    const known = lastWeightOf(workouts, planned.name)
    if (known == null) continue
    let weight: number | null = null
    if (typeof rec.weight === 'number' && Number.isFinite(rec.weight) && rec.weight > 0 && known != null) {
      if (rec.weight >= known * 0.5 && rec.weight <= known * 1.5) weight = roundPlate(rec.weight)
    }
    let reps: number | null = null
    if (typeof rec.reps === 'number' && Number.isInteger(rec.reps) && rec.reps >= 1 && rec.reps <= 50) reps = rec.reps
    if (weight == null && reps == null) continue
    guesses.push({ name: planned.name, weight, reps })
  }
  return guesses
}

/** Compact text for the silent finish call. History is the last few sessions only. */
export function coachGuessBrief(workouts: Workout[], finished: Workout, plan: MesoTemplateExercise[], unit: string): string {
  const lines: string[] = [`Unit: ${unit}`, '', 'FINISHED']
  for (const ex of finished.exercises) {
    if (ex.skipReason) continue
    const sets = ex.sets
      .filter((s) => isCompletedSet(s))
      .map((s) => `${s.weight ?? '?'}x${s.reps ?? '?'}`)
      .join(', ')
    if (sets) lines.push(`${ex.name}: ${sets}`)
  }
  lines.push('', 'HISTORY')
  const scoring = workouts.filter((w) => isScoringWorkout(w) && w.id !== finished.id)
  for (const ex of plan) {
    const key = norm(ex.name)
    const sessions: string[] = []
    for (const w of [...scoring].sort((a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt)) {
      const logged = w.exercises.find((e) => norm(e.name) === key)
      const done = logged ? performed(logged) : null
      if (!done) continue
      sessions.push(`${w.date}: ${done.weight}x${done.reps.join('/')}`)
      if (sessions.length === 3) break
    }
    const range = ex.repTarget ? `${ex.sets}x${ex.repTarget[0]}-${ex.repTarget[1]}` : `${ex.sets} sets`
    lines.push(`${ex.name} | ${range}${sessions.length ? ` | ${sessions.join('; ')}` : ' | no history'}`)
  }
  return lines.join('\n')
}
