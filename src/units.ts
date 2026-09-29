const KG_TO_LB = 2.2046226

export function kgToUnits(kg: number, appUnits: 'lbs' | 'kg'): number {
  const v = appUnits === 'kg' ? kg : kg * KG_TO_LB
  return Math.round(v * 10) / 10
}
