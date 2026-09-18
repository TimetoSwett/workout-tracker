import type { CoachMemory, DailyMetric, LoggedExercise, Mesocycle, Philosophy, Profile, Settings, Workout } from './types'
import { muscleGroupName } from './mesoEngine'
import { compileMetrics, nutritionBlock } from './nutrition'

/** Heaviest completed set of an exercise by estimated 1RM (Epley), for load-trend reporting. */
function bestSet(ex: LoggedExercise): { w: number; r: number; e1rm: number } | undefined {
  let best: { w: number; r: number; e1rm: number } | undefined
  for (const s of ex.sets) {
    if (s.status === 'skipped') continue
    const w = s.weight
    const r = s.reps
    if (w == null || r == null || r <= 0) continue
    const e1rm = w * (1 + r / 30)
    if (!best || e1rm > best.e1rm) best = { w, r, e1rm }
  }
  return best
}

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

export function compileWorkouts(workouts: Workout[], settings: Settings, mesocycles: Mesocycle[] = []): string {
  const lines: string[] = []
  lines.push(`Units: ${settings.units}`)
  lines.push(`Workouts (${workouts.length}), oldest first.`)
  lines.push(
    'Effort metrics: hard-set counts and rep distribution are primary; load trend (top set weight) matters for strength blocks. Do NOT compare raw tonnage (weight x reps summed) across phases — strength blocks run fewer, heavier sets by design and that is not detraining.',
  )
  const mesoById = new Map(mesocycles.map((m) => [m.id, m]))

  // Per-exercise load trends (best set, est 1RM via Epley, first → last in
  // this window) so the coach sees progression directly.
  const byExercise = new Map<
    string,
    { first?: { w: number; r: number; e1rm: number }; last?: { w: number; r: number; e1rm: number } }
  >()
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const best = bestSet(ex)
      if (!best) continue
      const e = byExercise.get(ex.name) ?? {}
      if (!e.first) e.first = best
      e.last = best
      byExercise.set(ex.name, e)
    }
  }
  const trends = [...byExercise.entries()]
    .filter(([, e]) => e.first && e.last && e.first.e1rm !== e.last.e1rm)
    .map(
      ([name, e]) =>
        `${name}: est 1RM ${Math.round(e.first!.e1rm)} → ${Math.round(e.last!.e1rm)} ${settings.units} (${e.first!.w}x${e.first!.r} → ${e.last!.w}x${e.last!.r})`,
    )
  if (trends.length) {
    lines.push('\n# LOAD TRENDS (best set per exercise, est 1RM, first → last in this window)')
    lines.push(...trends)
  }

  const announced = new Set<string>()
  for (const w of workouts) {
    const dur = w.endedAt ? ` (${durationMin(w)} min)` : ''
    const meso = w.mesoId ? ` [meso week ${(w.mesoWeek ?? 0) + 1}, day ${(w.mesoDayPosition ?? 0) + 1}]` : ''
    lines.push(`\n## ${w.date} — ${w.name ?? 'Workout'}${dur}${meso}`)
    if (w.mesoId && !announced.has(w.mesoId)) {
      announced.add(w.mesoId)
      const m = mesoById.get(w.mesoId)
      if (m) {
        lines.push(
          `Block: ${m.name} — ${m.weeksPlanned} weeks${m.deloadWeek != null ? `, deload on week ${m.deloadWeek + 1}` : ''}${m.goal ? `, intent: ${m.goal}` : ''}`,
        )
      }
    }
    if (w.activity) {
      lines.push(`Activity: ${w.activity.type}, ${w.activity.durationMin} min (non-lifting session)`)
    }
    let hardSets = 0
    const repBuckets = { '1-5': 0, '6-10': 0, '11-15': 0, '16+': 0 }
    for (const ex of w.exercises) {
      const sets = ex.sets
        .map((s) => {
          if ((s.reps ?? 0) > 0) {
            hardSets++
            const r = s.reps!
            if (r <= 5) repBuckets['1-5']++
            else if (r <= 10) repBuckets['6-10']++
            else if (r <= 15) repBuckets['11-15']++
            else repBuckets['16+']++
          }
          const actual = `${s.weight ?? '?'}${settings.units}x${s.reps ?? '?'}`
          const hasTarget = s.weightTarget != null || s.repsTarget != null
          return hasTarget ? `${actual} (target ${s.weightTarget ?? '?'}${settings.units}x${s.repsTarget ?? '?'})` : actual
        })
        .join(', ')
      lines.push(`- ${ex.name}: ${sets}`)
      if (ex.notes) lines.push(`  notes: ${ex.notes}`)
    }
    if (w.exercises.length > 0) {
      lines.push(
        `Session summary: ${hardSets} hard sets; reps ${repBuckets['1-5']}x1-5 / ${repBuckets['6-10']}x6-10 / ${repBuckets['11-15']}x11-15 / ${repBuckets['16+']}x16+`,
      )
    }
    if (w.muscleFeedback?.length) {
      const feedback = w.muscleFeedback
        .map((f) => {
          const parts: string[] = []
          if (f.pump != null) parts.push(`pump ${f.pump}`)
          if (f.soreness != null) parts.push(`soreness ${f.soreness}`)
          if (f.workload != null) parts.push(`workload ${f.workload}`)
          return `${muscleGroupName(f.muscleGroupId, settings.muscleGroupNames)}: ${parts.join(', ')}`
        })
        .join(' · ')
      lines.push(`Muscle feedback: ${feedback}`)
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

const COACH_PERSONA = `You are the user's ongoing strength & conditioning coach. You help them pursue
their fitness goals — strength, muscle, health — using current peer-reviewed
research on strength training and hypertrophy (volume landmarks, proximity to
failure, frequency effects, minimum effective dose). When evidence is mixed or
thin, say so instead of guessing.

You are reviewing logged workout data (weight x reps per set) and, when provided,
health metrics and notes from the user. This is a continuing relationship: you
may be given remembered facts from earlier conversations — treat those as
context you know about this athlete, and keep them consistent.

When analyzing logs:
- Compute weekly set counts and volume per muscle group / movement pattern
- Identify progression (or stagnation) on key lifts
- Check balance (push vs pull, quads vs hamstrings, etc.) and flag gaps
- Suggest concrete changes: volume adjustments, exercise swaps, deload timing
- Answer general training/nutrition questions directly — analysis is not required
  for you to be useful`

function memoryBlock(memory: CoachMemory | null): string {
  if (!memory?.facts?.length) return ''
  return `\n# REMEMBERED FACTS ABOUT THIS ATHLETE (from earlier conversations)\n${memory.facts.map((f) => `- ${f}`).join('\n')}`
}

function notesBlock(notes: string | undefined): string {
  if (!notes?.trim()) return ''
  return `\n# NOTES FROM THE USER (always respect)\n${notes.trim()}`
}

export function coachSystem(
  philosophy: Philosophy,
  profile: Profile | undefined,
  settings: Settings,
  metrics?: DailyMetric[],
  memory?: CoachMemory | null | undefined,
): string {
  return `${COACH_PERSONA}

# COACHING PHILOSOPHY: ${PHILOSOPHY_LABELS[philosophy].toUpperCase()}
${philosophyBlock(philosophy)}

${RECOVERY_BLOCK}
${profileBlock(profile, settings)}${nutritionBlock(settings.goal, profile, settings)}${metrics ? compileMetrics(metrics, settings) : ''}${memoryBlock(memory ?? null)}${notesBlock(settings.coachNotes)}

Be specific and reference actual numbers from the logs. Use markdown with short sections and bullet points.
Keep it actionable — no generic filler. If data seems inconsistent or incomplete, note it briefly and work with what's there.`
}

export const MEMORY_SYSTEM = `You maintain a compact memory of facts about an athlete for their AI strength coach.
You are given the current memory (possibly empty) and a conversation with their training data.
Return an UPDATED list of durable facts worth remembering across future conversations.

Rules:
- Keep only stable, useful facts: training preferences, injury history, recovery patterns, life constraints, coaching decisions made, consistent behaviors
- Drop facts that became obsolete; correct facts that were proven wrong
- Maximum 15 facts, each one sentence, plain text
- No numbers dumps — only remember numbers that carry meaning (e.g. "benches best with pause work", not "benched 205x5 on Sep 3")
- If nothing new or changed, return the current list unchanged

Respond with ONLY the updated facts as a JSON array of strings.`
