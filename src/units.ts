const KG_TO_LB = 2.2046226

export type Units = 'lbs' | 'kg'

export function kgToUnits(kg: number, appUnits: Units): number {
  const v = appUnits === 'kg' ? kg : kg * KG_TO_LB
  return Math.round(v * 10) / 10
}

/** Reinterprets a bare stored number from one unit to the other. Every weight this app
 *  persists — set weights, bodyweights, daily metrics, the goal rate — is a bare number
 *  in whatever `settings.units` was at the time, so switching the setting has to rewrite
 *  them; see `convertStoredWeights`. */
export function convertWeight(v: number, from: Units, to: Units, decimals = 1): number {
  if (from === to) return v
  const kg = from === 'kg' ? v : v / KG_TO_LB
  const p = 10 ** decimals
  return Math.round((to === 'kg' ? kg : kg * KG_TO_LB) * p) / p
}
