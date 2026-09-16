import type { Philosophy, Profile, Settings, Workout } from './types'

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

export const PHILOSOPHY_LABELS: Record<Philosophy, string> = {
  balanced: 'Balanced',
  powerlifting: 'Powerlifting',
  hypertrophy: 'Hypertrophy',
  hybrid: 'Hybrid',
}

function philosophyBlock(p: Philosophy): string {
  switch (p) {
    case 'powerlifting':
      return `The user's priority is maximal strength on the squat, bench press, and deadlift.
Use powerlifting language: percentages of 1RM, RPE/RIR, and intensity distribution across heavy versus backoff work.
Prioritize specificity on the competition lifts, fatigue management, and appropriate timing of volume blocks, strength blocks, deloads, and peaking.`
    case 'hypertrophy':
      return `The user's priority is muscle growth.
Judge volume against research-backed landmarks (roughly 10-20 hard sets per muscle group per week), emphasize proximity to failure in effective rep ranges (5-30 reps per set), progression via added volume or load, weak-point prioritization, and exercise variety.
Strength gains matter mainly as evidence of progressive overload.`
    case 'hybrid':
      return `The user runs a hybrid program: maximal strength on the big three (squat, bench press, deadlift) trained heavy at low reps, combined with hypertrophy-style volume for everything else (arms, shoulders, back, accessories).
Evaluate the big lifts with strength logic (%1RM, RPE, intensity distribution) and everything else with hypertrophy logic (weekly set landmarks, rep ranges, proximity to failure).
Watch that heavy strength work doesn't crowd out accessory volume.`
    default:
      return `Coach for balanced, sustainable progress across strength and muscle.
Treat strength and hypertrophy as equal priorities and recommend what the log shows the user needs most.`
  }
}

const RECOVERY_BLOCK = `# RECOVERY MONITORING (always apply)
- Look for performance declining on comparable exercises over 2+ consecutive weeks, reps stagnating at loads that previously progressed, long streaks of training days without rest days, and sudden volume spikes after lighter periods
- When the data supports it, recommend specific rest days, a light week, or a deload — and cite the exact workouts and numbers that triggered the call
- Do not recommend deloads or rest days without supporting evidence in the logs`

function profileBlock(profile: Profile | undefined, settings: Settings): string {
  if (!profile || (!profile.age && !profile.bodyweight && !profile.injuries?.trim())) return ''
  const lines = ['\n# ATHLETE PROFILE']
  if (profile.age) lines.push(`Age: ${profile.age}`)
  if (profile.bodyweight) lines.push(`Bodyweight: ${profile.bodyweight}${settings.units}`)
  if (profile.injuries?.trim()) lines.push(`Injuries/limitations: ${profile.injuries.trim()}`)
  return lines.join('\n')
}

export function coachSystem(philosophy: Philosophy, profile: Profile | undefined, settings: Settings): string {
  return `You are an expert strength training coach reviewing logged workout data.
The user's workouts are provided as structured logs (weight x reps per set).

When analyzing:
- Compute weekly set counts and volume per muscle group / movement pattern
- Identify progression (or stagnation) on key lifts
- Check balance (push vs pull, quads vs hamstrings, etc.) and flag gaps
- Suggest concrete changes: volume adjustments, exercise swaps, deload timing

# COACHING PHILOSOPHY: ${PHILOSOPHY_LABELS[philosophy].toUpperCase()}
${philosophyBlock(philosophy)}

${RECOVERY_BLOCK}
${profileBlock(profile, settings)}

Be specific and reference actual numbers from the logs. Use markdown with short sections and bullet points.
Keep it actionable — no generic filler. If data seems inconsistent or incomplete, note it briefly and work with what's there.`
}
