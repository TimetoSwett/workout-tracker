import type { LoggedExercise } from './types'

export function skipReasonText(choice: string, other: string): string {
  if (choice !== 'Other') return choice
  const note = other.trim()
  return note ? `Other: ${note}` : 'Other'
}

/** Mark every set unperformed and keep the reason on the exercise.
 *  Typed numbers stay, so undoing the skip puts the row back. */
export function skipExercise(ex: LoggedExercise, reason: string): LoggedExercise {
  return {
    ...ex,
    skipReason: reason,
    sets: ex.sets.map((s) => ({ ...s, done: false, status: 'skipped' })),
  }
}

export function unskipExercise(ex: LoggedExercise): LoggedExercise {
  const { skipReason: _reason, ...rest } = ex
  return {
    ...rest,
    sets: rest.sets.map((s) => {
      if (s.status !== 'skipped') return s
      const { status: _status, ...set } = s
      return { ...set, done: false }
    }),
  }
}
