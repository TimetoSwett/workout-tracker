import type { Settings, Workout } from './types'

export function volumeOf(w: Workout): number {
  return w.exercises.reduce(
    (sum, ex) => sum + ex.sets.reduce((s, set) => s + (set.weight ?? 0) * (set.reps ?? 0), 0),
    0,
  )
}

export function setCount(w: Workout): number {
  return w.exercises.reduce((n, ex) => n + ex.sets.length, 0)
}

export function durationMin(w: Workout): number {
  const end = w.endedAt ?? w.startedAt
  return Math.round((end - w.startedAt) / 60000)
}

export function compileWorkouts(workouts: Workout[], settings: Settings): string {
  const lines: string[] = []
  lines.push(`Units: ${settings.units}`)
  lines.push(`Workouts (${workouts.length}), oldest first:`)
  for (const w of workouts) {
    const dur = w.endedAt ? ` (${durationMin(w)} min)` : ''
    lines.push(`\n## ${w.date} — ${w.name ?? 'Workout'}${dur}`)
    for (const ex of w.exercises) {
      const sets = ex.sets
        .map((s) => `${s.weight ?? '?'}${settings.units}x${s.reps ?? '?'}`)
        .join(', ')
      lines.push(`- ${ex.name}: ${sets}`)
      if (ex.notes) lines.push(`  notes: ${ex.notes}`)
    }
    if (w.notes) lines.push(`Session notes: ${w.notes}`)
  }
  return lines.join('\n')
}

export const COACH_SYSTEM = `You are an expert strength training coach reviewing logged workout data.
The user's workouts are provided as structured logs (weight x reps per set).

When analyzing:
- Compute weekly set counts and volume per muscle group / movement pattern
- Identify progression (or stagnation) on key lifts
- Check balance (push vs pull, quads vs hamstrings, etc.) and flag gaps
- Suggest concrete changes: volume adjustments, exercise swaps, deload timing

Be specific and reference actual numbers from the logs. Use markdown with short sections and bullet points.
Keep it actionable — no generic filler. If data seems inconsistent or incomplete, note it briefly and work with what's there.`
