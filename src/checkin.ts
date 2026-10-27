import type { LoggedExercise } from './types'

/**
 * The per-exercise check-in, worded and scaled like the RP Strength app so a rating given here
 * means the same thing as one in imported RP data: soreness 0-3, joint pain 0-3, pump 0-2,
 * workload 0-3. The stored value is the number; the label is only what the button says.
 */
export interface CheckinOption {
  value: number
  label: string
}

export const SORENESS_OPTIONS: CheckinOption[] = [
  { value: 0, label: 'Never got sore' },
  { value: 1, label: 'Healed a while ago' },
  { value: 2, label: 'Healed just in time' },
  { value: 3, label: "I'm still sore" },
]

export const JOINT_PAIN_OPTIONS: CheckinOption[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Low pain' },
  { value: 2, label: 'Moderate pain' },
  { value: 3, label: 'A lot of pain' },
]

export const PUMP_OPTIONS: CheckinOption[] = [
  { value: 0, label: 'Low' },
  { value: 1, label: 'Moderate' },
  { value: 2, label: 'Amazing' },
]

export const WORKLOAD_OPTIONS: CheckinOption[] = [
  { value: 0, label: 'Easy' },
  { value: 1, label: 'Pretty good' },
  { value: 2, label: 'Pushed my limits' },
  { value: 3, label: 'Too much' },
]

/** Soreness and joint pain are asked once the first set is done; pump and workload when every set is. */
export type CheckinPhase = 'start' | 'end'

type Checkin = Pick<LoggedExercise, 'skipReason' | 'sets' | 'soreness' | 'jointPain' | 'pump' | 'workload'>

/** Whether the exercise has got far enough for this phase to be asked. A skipped exercise never is. */
export function phaseReached(ex: Checkin, phase: CheckinPhase): boolean {
  if (ex.skipReason || ex.sets.length === 0) return false
  return phase === 'start' ? ex.sets.some((s) => s.done === true) : ex.sets.every((s) => s.done === true)
}

/** Both questions of the phase have an answer. */
export function phaseAnswered(ex: Checkin, phase: CheckinPhase): boolean {
  return phase === 'start' ? ex.soreness != null && ex.jointPain != null : ex.pump != null && ex.workload != null
}

/** Neither question of the phase has an answer. */
export function phaseUntouched(ex: Checkin, phase: CheckinPhase): boolean {
  return phase === 'start' ? ex.soreness == null && ex.jointPain == null : ex.pump == null && ex.workload == null
}

function labelOf(options: CheckinOption[], value: number | undefined): string | null {
  if (value == null) return null
  return options.find((o) => o.value === value)?.label ?? String(value)
}

/** "Soreness: Healed just in time · Joint pain: None" for one phase, or null when unanswered. */
export function phaseSummary(ex: Checkin, phase: CheckinPhase): string | null {
  const parts =
    phase === 'start'
      ? [
          ['Soreness', labelOf(SORENESS_OPTIONS, ex.soreness)],
          ['Joint pain', labelOf(JOINT_PAIN_OPTIONS, ex.jointPain)],
        ]
      : [
          ['Pump', labelOf(PUMP_OPTIONS, ex.pump)],
          ['Workload', labelOf(WORKLOAD_OPTIONS, ex.workload)],
        ]
  const answered = parts.filter((p): p is [string, string] => p[1] != null)
  return answered.length ? answered.map(([name, label]) => `${name}: ${label}`).join(' · ') : null
}
