import type { Mesocycle } from './types'

/** A new plan from an imported meso's structure.
 *
 *  The copy gets a new meso id, new day ids, and new exercise ids, so logged
 *  workouts on the original cannot drive its targets. Completion is reset:
 *  the copy is an active plan with no finish time. `source` is not modified.
 */
export function cloneMesoAsTemplate(source: Mesocycle, now: number, newId: () => string): Mesocycle {
  return {
    id: newId(),
    name: source.name,
    unit: source.unit,
    weeksPlanned: Math.max(1, source.weeksPlanned || 0),
    ...(source.deloadWeek != null ? { deloadWeek: source.deloadWeek } : {}),
    days: source.days.map((day) => ({
      id: newId(),
      label: day.label,
      exercises: day.exercises.map((ex) => ({
        id: newId(),
        name: ex.name,
        sets: ex.sets,
        ...(ex.muscleGroupId != null ? { muscleGroupId: ex.muscleGroupId } : {}),
        ...(ex.repTarget ? { repTarget: [ex.repTarget[0], ex.repTarget[1]] as [number, number] } : {}),
      })),
    })),
    priorities: source.priorities.map((p) => ({ muscleGroupId: p.muscleGroupId, type: p.type })),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    imported: false,
    ...(source.goal ? { goal: source.goal } : {}),
  }
}
