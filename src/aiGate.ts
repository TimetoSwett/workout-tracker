import type { Settings } from './types'

/** The board's "Show AI features" switch.
 *
 *  Absent means on: an install that predates the switch keeps every AI feature it already
 *  had, and nothing has to be migrated. Only an explicit `false` turns the features off.
 *
 *  This is the one predicate for the whole app — views use it to decide what to render,
 *  `ai.ts` uses it to refuse provider calls, and `coachStore.ts` uses it to skip the coach
 *  file's background sync. It is deliberately free of side effects and of any import that
 *  touches the network, so a view can ask the question without pulling in the AI client. */
export function aiFeaturesEnabled(settings: Pick<Settings, 'aiEnabled'>): boolean {
  return settings.aiEnabled !== false
}

/** Rejection produced when something tries to reach an AI provider while the features are
 *  off. A caller should never have to handle this — every entry point is hidden first —
 *  so it exists to make the failure obvious rather than to be caught and rendered. */
export class AIDisabled extends Error {
  constructor() {
    super('AI features are turned off in Settings')
    this.name = 'AIDisabled'
  }
}
