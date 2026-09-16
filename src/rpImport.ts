import type { LoggedExercise, LoggedSet, Mesocycle, MesoPriority, MesoTemplateDay, MesoTemplateExercise, MuscleFeedback, Workout } from './types'

/**
 * Minimal shape of an RP Strength export mesocycle — only the fields this
 * importer actually reads. The real export carries many more fields; we
 * ignore anything not listed here.
 */
interface RpSet {
  weight?: number | null
  weightTarget?: number | null
  reps?: number | null
  repsTarget?: number | null
  status?: string
  finishedAt?: string | null
}

interface RpExercise {
  id: number
  name: string
  muscleGroupId?: number
  sourceDayExerciseId?: number | null
  sets?: RpSet[]
}

interface RpMuscleGroupFeedback {
  muscleGroupId: number
  pump?: number | null
  soreness?: number | null
  workload?: number | null
  recommendedSets?: number | null
}

interface RpDay {
  id: number
  week: number
  position: number
  status?: string
  label?: string
  notes?: unknown
  bodyweight?: number | null
  createdAt: string
  updatedAt: string
  finishedAt?: string | null
  exercises?: RpExercise[]
  muscleGroups?: RpMuscleGroupFeedback[]
}

interface RpWeek {
  days?: RpDay[]
}

interface RpPriority {
  muscleGroupId: number
  mgPriorityType: 'grow' | 'maintain' | 'emphasize'
}

interface RpMeso {
  id: number
  name: string
  unit?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string | null
  weeks?: RpWeek[]
  priorities?: Record<string, RpPriority>
}

export interface RpImportResult {
  workouts: Workout[]
  mesocycles: Mesocycle[]
  /** Muscle-group IDs whose name is a guess, not confirmed against RP's own labels. */
  ambiguousMuscleGroups: number[]
}

const AMBIGUOUS_MUSCLE_GROUPS = [5, 7, 8, 10]

function joinNotes(notes: unknown): string | undefined {
  if (!Array.isArray(notes)) return undefined
  const lines = notes
    .map((n) => (typeof n === 'string' ? n : typeof n === 'object' && n && 'text' in n ? String((n as { text: unknown }).text) : null))
    .filter((n): n is string => !!n?.trim())
  return lines.length ? lines.join('\n') : undefined
}

function dayTimeRange(day: RpDay): { startedAt: number; endedAt?: number } {
  const times: number[] = []
  for (const ex of day.exercises ?? []) {
    for (const s of ex.sets ?? []) {
      if (s.finishedAt) times.push(Date.parse(s.finishedAt))
    }
  }
  if (times.length) return { startedAt: Math.min(...times), endedAt: Math.max(...times) }
  const created = Date.parse(day.createdAt)
  const finished = day.finishedAt ? Date.parse(day.finishedAt) : undefined
  return { startedAt: created, endedAt: finished }
}

function mapDayStatus(status: string | undefined): 'complete' | 'partial' | 'skipped' {
  if (status === 'complete') return 'complete'
  if (status === 'skipped') return 'skipped'
  return 'partial'
}

function mapSetStatus(status: string | undefined): 'complete' | 'skipped' | 'pending' {
  if (status === 'complete') return 'complete'
  if (status === 'skipped') return 'skipped'
  return 'pending'
}

function mapDay(day: RpDay, mesoId: string, mesoName: string): Workout {
  const { startedAt, endedAt } = dayTimeRange(day)
  const exercises: LoggedExercise[] = (day.exercises ?? []).map((ex) => ({
    id: `rp-ex-${ex.id}`,
    name: ex.name,
    muscleGroupId: ex.muscleGroupId,
    templateExerciseId: `rp-tex-${ex.sourceDayExerciseId ?? ex.id}`,
    sets: (ex.sets ?? []).map(
      (s): LoggedSet => ({
        weight: s.weight ?? null,
        reps: s.reps ?? null,
        done: s.status === 'complete',
        weightTarget: s.weightTarget ?? null,
        repsTarget: s.repsTarget ?? null,
        status: mapSetStatus(s.status),
      }),
    ),
  }))
  const muscleFeedback: MuscleFeedback[] = (day.muscleGroups ?? []).map((mg) => ({
    muscleGroupId: mg.muscleGroupId,
    pump: mg.pump ?? undefined,
    soreness: mg.soreness ?? undefined,
    workload: mg.workload ?? undefined,
    recommendedSets: mg.recommendedSets ?? undefined,
  }))
  return {
    id: `rp-day-${day.id}`,
    date: new Date(startedAt).toISOString().slice(0, 10),
    startedAt,
    endedAt,
    name: mesoName,
    exercises,
    notes: joinNotes(day.notes),
    updatedAt: Date.parse(day.updatedAt),
    mesoId,
    mesoWeek: day.week,
    mesoDayPosition: day.position,
    status: mapDayStatus(day.status),
    bodyweight: day.bodyweight ?? undefined,
    muscleFeedback: muscleFeedback.length ? muscleFeedback : undefined,
  }
}

function mapTemplate(meso: RpMeso): MesoTemplateDay[] {
  const week0 = meso.weeks?.[0]
  if (!week0?.days) return []
  return week0.days.map((day) => ({
    id: `rp-day-${day.id}`,
    label: day.label || `Day ${day.position + 1}`,
    exercises: (day.exercises ?? []).map(
      (ex): MesoTemplateExercise => ({
        id: `rp-tex-${ex.sourceDayExerciseId ?? ex.id}`,
        name: ex.name,
        muscleGroupId: ex.muscleGroupId,
        sets: ex.sets?.length ?? 0,
      }),
    ),
  }))
}

function mapMeso(meso: RpMeso): Mesocycle {
  const priorities: MesoPriority[] = Object.values(meso.priorities ?? {}).map((p) => ({
    muscleGroupId: p.muscleGroupId,
    type: p.mgPriorityType,
  }))
  const weeksPlanned = meso.weeks?.length ?? 0
  return {
    id: `rp-${meso.id}`,
    name: meso.name,
    unit: meso.unit === 'kg' ? 'kg' : 'lbs',
    weeksPlanned,
    deloadWeek: weeksPlanned > 0 ? weeksPlanned - 1 : undefined,
    days: mapTemplate(meso),
    priorities,
    status: 'complete',
    createdAt: Date.parse(meso.createdAt),
    finishedAt: meso.finishedAt ? Date.parse(meso.finishedAt) : undefined,
    updatedAt: Date.parse(meso.updatedAt),
    imported: true,
  }
}

/** Parses a raw RP Strength export (array of mesocycles) into this app's Workout/Mesocycle shapes. */
export function parseRpExport(raw: string): RpImportResult {
  const data = JSON.parse(raw) as RpMeso[]
  if (!Array.isArray(data)) throw new Error('Expected an array of mesocycles')
  const workouts: Workout[] = []
  const mesocycles: Mesocycle[] = []
  for (const meso of data) {
    const mesoId = `rp-${meso.id}`
    mesocycles.push(mapMeso(meso))
    for (const week of meso.weeks ?? []) {
      for (const day of week.days ?? []) {
        workouts.push(mapDay(day, mesoId, meso.name))
      }
    }
  }
  return { workouts, mesocycles, ambiguousMuscleGroups: AMBIGUOUS_MUSCLE_GROUPS }
}
