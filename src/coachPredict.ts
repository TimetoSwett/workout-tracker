import type { AISettings, Mesocycle, Workout } from './types'
import { aiChat } from './ai'
import { acceptCoachGuesses, coachGuessBrief, exercisesToGuess } from './predictions'
import { saveGuesses } from './targetStore'

const SYSTEM = `You set the next weight and reps for each exercise after a finished workout.
Reply with ONLY a JSON array. Each item is {"name": string, "weight": number, "reps": number}.
Copy each name exactly from the plan lines. Weight is in the unit given.
Use that exercise's own history and what just happened for its muscle. Do not copy one lift's weight onto a different lift.
If an exercise has no history, omit it. One item per exercise you can judge. No prose.`

/** Reads the finished workout and stores next targets. No chat message is produced.
 *  A local guess is already saved; this only replaces a target when the reply is usable. */
export async function refineGuesses(ai: AISettings, workouts: Workout[], finished: Workout, meso: Mesocycle | null, unit: 'lbs' | 'kg'): Promise<void> {
  const plan = exercisesToGuess(meso, finished)
  if (plan.length === 0) return
  try {
    const reply = await aiChat(ai, SYSTEM, [{ role: 'user', content: coachGuessBrief(workouts, finished, plan, unit) }], { timeoutMs: 25_000 })
    const accepted = acceptCoachGuesses(reply, plan, workouts)
    if (accepted.length > 0) saveGuesses(accepted)
  } catch {
    // Finish already stored a local guess. Silence is the point of this call.
  }
}
