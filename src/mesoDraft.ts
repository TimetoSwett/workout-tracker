import type { Mesocycle, MesoPriority, MesoTemplateDay, Template, Workout } from './types'
import { EXERCISE_PRESETS, MUSCLE_GROUPS } from './types'

const VALID_UNITS = new Set(['lbs', 'kg'])
const VALID_PRIORITY_TYPES = new Set<MesoPriority['type']>(['grow', 'maintain', 'emphasize'])
const VALID_MUSCLE_GROUP_IDS = new Set(MUSCLE_GROUPS.map((g) => g.id))

export interface MesoDraftExerciseJSON {
  name: string
  muscleGroupId?: number
  sets: number
  repTarget?: [number, number]
}

export interface MesoDraftDayJSON {
  label: string
  exercises: MesoDraftExerciseJSON[]
}

export interface MesoDraftPriorityJSON {
  muscleGroupId: number
  type: MesoPriority['type']
}

export interface MesoDraftJSON {
  name: string
  goal?: string
  unit: 'lbs' | 'kg'
  weeksPlanned: number
  deloadWeek?: number
  days: MesoDraftDayJSON[]
  priorities: MesoDraftPriorityJSON[]
}

/** Pulls the JSON payload out of a reply that may wrap it in a ```json fence or prose. */
function extractJsonPayload(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in the reply.')
  }
  return text.slice(start, end + 1)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function validateExercise(e: unknown, dayIdx: number, exIdx: number): MesoDraftExerciseJSON {
  if (!isRecord(e)) throw new Error(`days[${dayIdx}].exercises[${exIdx}] must be an object.`)
  if (typeof e.name !== 'string' || !e.name.trim()) {
    throw new Error(`days[${dayIdx}].exercises[${exIdx}].name must be a non-empty string.`)
  }
  if (!Number.isInteger(e.sets) || (e.sets as number) < 1) {
    throw new Error(`days[${dayIdx}].exercises[${exIdx}].sets must be a positive integer.`)
  }
  let muscleGroupId: number | undefined
  if (e.muscleGroupId != null) {
    if (!VALID_MUSCLE_GROUP_IDS.has(e.muscleGroupId as number)) {
      throw new Error(`days[${dayIdx}].exercises[${exIdx}].muscleGroupId (${e.muscleGroupId}) is not a known muscle group id.`)
    }
    muscleGroupId = e.muscleGroupId as number
  }
  let repTarget: [number, number] | undefined
  if (e.repTarget != null) {
    const r = e.repTarget
    if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n > 0)) {
      throw new Error(`days[${dayIdx}].exercises[${exIdx}].repTarget must be a [min, max] pair of positive integers.`)
    }
    repTarget = [r[0], r[1]]
  }
  return { name: e.name.trim(), muscleGroupId, sets: e.sets as number, repTarget }
}

function validateDay(d: unknown, dayIdx: number): MesoDraftDayJSON {
  if (!isRecord(d)) throw new Error(`days[${dayIdx}] must be an object.`)
  if (typeof d.label !== 'string' || !d.label.trim()) {
    throw new Error(`days[${dayIdx}].label must be a non-empty string.`)
  }
  if (!Array.isArray(d.exercises) || d.exercises.length === 0) {
    throw new Error(`days[${dayIdx}].exercises must be a non-empty array.`)
  }
  return {
    label: d.label.trim(),
    exercises: d.exercises.map((e, i) => validateExercise(e, dayIdx, i)),
  }
}

function validatePriority(p: unknown, idx: number): MesoDraftPriorityJSON {
  if (!isRecord(p)) throw new Error(`priorities[${idx}] must be an object.`)
  if (!VALID_MUSCLE_GROUP_IDS.has(p.muscleGroupId as number)) {
    throw new Error(`priorities[${idx}].muscleGroupId (${p.muscleGroupId}) is not a known muscle group id.`)
  }
  if (typeof p.type !== 'string' || !VALID_PRIORITY_TYPES.has(p.type as MesoPriority['type'])) {
    throw new Error(`priorities[${idx}].type must be one of "grow", "maintain", "emphasize".`)
  }
  return { muscleGroupId: p.muscleGroupId as number, type: p.type as MesoPriority['type'] }
}

/** Validates the model's reply against the meso draft contract described in `mesoPlanSystem`. */
export function validateMesoDraftShape(v: unknown): MesoDraftJSON {
  if (!isRecord(v)) throw new Error('Reply JSON must be an object.')
  if (typeof v.name !== 'string' || !v.name.trim()) throw new Error('"name" must be a non-empty string.')
  if (typeof v.unit !== 'string' || !VALID_UNITS.has(v.unit)) throw new Error('"unit" must be "lbs" or "kg".')
  if (!Number.isInteger(v.weeksPlanned) || (v.weeksPlanned as number) < 1) {
    throw new Error('"weeksPlanned" must be a positive integer.')
  }
  const weeksPlanned = v.weeksPlanned as number
  let deloadWeek: number | undefined
  if (v.deloadWeek != null) {
    if (!Number.isInteger(v.deloadWeek) || (v.deloadWeek as number) < 0 || (v.deloadWeek as number) >= weeksPlanned) {
      throw new Error('"deloadWeek" must be an integer week index (0-based) within weeksPlanned.')
    }
    deloadWeek = v.deloadWeek as number
  }
  if (!Array.isArray(v.days) || v.days.length === 0) throw new Error('"days" must be a non-empty array.')
  const days = v.days.map((d, i) => validateDay(d, i))
  let priorities: MesoDraftPriorityJSON[] = []
  if (v.priorities != null) {
    if (!Array.isArray(v.priorities)) throw new Error('"priorities" must be an array.')
    priorities = v.priorities.map((p, i) => validatePriority(p, i))
  }
  return {
    name: v.name.trim(),
    goal: typeof v.goal === 'string' ? v.goal.trim() : undefined,
    unit: v.unit as 'lbs' | 'kg',
    weeksPlanned,
    deloadWeek,
    days,
    priorities,
  }
}

/** Parses and validates a model reply in one step. Throws with a message suitable for
 *  showing the user or feeding back to the model as a correction request. */
export function parseMesoDraftJson(text: string): MesoDraftJSON {
  const payload = extractJsonPayload(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (e) {
    throw new Error(`Reply was not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return validateMesoDraftShape(parsed)
}

/** Every exercise name the app already knows about: built-in presets plus anything the
 *  user has logged, saved in a template, or used in a past mesocycle. Mirrors the set
 *  `ExercisePicker` offers, so a coach-generated draft is judged against the same list
 *  the user would pick from by hand. */
export function collectKnownExerciseNames(workouts: Workout[], templates: Template[], mesocycles: Mesocycle[]): Set<string> {
  const names = new Set<string>(EXERCISE_PRESETS)
  for (const w of workouts) for (const ex of w.exercises) names.add(ex.name)
  for (const t of templates) for (const ex of t.exercises) names.add(ex.name)
  for (const m of mesocycles) for (const d of m.days) for (const ex of d.exercises) names.add(ex.name)
  return names
}

export interface MesoDraftResult {
  meso: Mesocycle
  /** Exercise names the model proposed that don't match anything in `collectKnownExerciseNames` —
   *  surfaced so the user can confirm, rename, or pick a substitute before saving. */
  unmatchedExerciseNames: string[]
}

/** Builds a fully-formed, in-memory `Mesocycle` from a validated draft. Nothing is
 *  persisted here — the caller decides whether/when to save it. */
export function buildMesoDraft(json: MesoDraftJSON, knownNames: Set<string>): MesoDraftResult {
  const canonicalByLower = new Map<string, string>()
  for (const n of knownNames) canonicalByLower.set(n.toLowerCase(), n)

  const unmatched: string[] = []
  const days: MesoTemplateDay[] = json.days.map((d) => ({
    id: crypto.randomUUID(),
    label: d.label,
    exercises: d.exercises.map((ex) => {
      const canonical = canonicalByLower.get(ex.name.toLowerCase())
      if (!canonical) unmatched.push(ex.name)
      return {
        id: crypto.randomUUID(),
        name: canonical ?? ex.name,
        muscleGroupId: ex.muscleGroupId,
        sets: ex.sets,
        repTarget: ex.repTarget,
      }
    }),
  }))

  const priorities: MesoPriority[] = json.priorities
    .filter((p) => p.type !== 'maintain')
    .map((p) => ({ muscleGroupId: p.muscleGroupId, type: p.type }))

  const now = Date.now()
  const meso: Mesocycle = {
    id: crypto.randomUUID(),
    name: json.name,
    unit: json.unit,
    weeksPlanned: json.weeksPlanned,
    deloadWeek: json.deloadWeek ?? Math.max(0, json.weeksPlanned - 1),
    days,
    priorities,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    goal: json.goal,
  }
  return { meso, unmatchedExerciseNames: [...new Set(unmatched)] }
}
