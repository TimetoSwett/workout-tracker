import type { TargetGuess } from './predictions'

const KEY = 'wt.targets.v1'

function norm(name: string): string {
  return name.trim().toLowerCase()
}

/** Guesses saved when a workout is finished. Keyed by the exact exercise name. */
export function loadGuesses(): Record<string, { weight: number | null; reps: number | null }> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, { weight: number | null; reps: number | null }>
  } catch {
    return {}
  }
}

export function saveGuesses(guesses: TargetGuess[]) {
  const next = loadGuesses()
  for (const g of guesses) {
    if (g.weight == null && g.reps == null) continue
    next[norm(g.name)] = { weight: g.weight, reps: g.reps }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // The next session can still be guessed from history if this write fails.
  }
}
