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
  const p = 10 ** decimals
  return Math.round(convertWeightExact(v, from, to) * p) / p
}

/** Unrounded conversion, for the sync wire format. Rounding on the way out would
 *  compound: a device that rounds to 0.1 on upload and the receiver that rounds again on
 *  download would walk a weight a little further every round trip. Keeping the wire value
 *  exact makes `local -> wire -> local` return the number the board actually typed. */
export function convertWeightExact(v: number, from: Units, to: Units): number {
  if (from === to) return v
  return from === 'kg' ? v * KG_TO_LB : v / KG_TO_LB
}
