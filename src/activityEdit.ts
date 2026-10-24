import type { Workout } from './types'
import { ACTIVITY_TYPES } from './types'

export interface ActivityEdit {
  type: string
  style?: string
  durationMin: number
  date: string
  notes?: string
}

/** Update a logged activity in place. The id stays, so sync revises this session
 *  instead of adding another. A type with no styles drops a leftover style. */
export function editedActivity(original: Workout, edit: ActivityEdit, now: number): Workout {
  const kind = ACTIVITY_TYPES.find((a) => a.type === edit.type)
  const style = kind?.styles?.includes(edit.style ?? '') ? edit.style : undefined
  const startedAt = new Date(edit.date + 'T12:00:00').getTime()
  const notes = edit.notes?.trim() || undefined
  return {
    ...original,
    date: edit.date,
    startedAt,
    endedAt: startedAt + edit.durationMin * 60000,
    name: style ? `${edit.type} — ${style}` : edit.type,
    notes,
    updatedAt: now,
    activity: { type: edit.type, durationMin: edit.durationMin, ...(style ? { style } : {}) },
  }
}
