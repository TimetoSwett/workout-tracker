import type { DailyMetric, Goal, Settings } from './types'

export function nutritionBlock(goal: Goal | undefined, profile: Settings['profile'], settings: Settings): string {
  if (!goal) return ''
  const lines = ['\n# NUTRITION COACHING (always apply)']
  const bw = profile?.bodyweight
  if (bw) {
    const bwKg = settings.units === 'kg' ? bw : bw / 2.2046
    const lines2: string[] = []
    lines2.push(`Goal: ${goal.type}${goal.ratePerWeek ? ` (~${goal.ratePerWeek} ${settings.units}/week target rate)` : ''}`)
    if (goal.type === 'cut') {
      lines2.push('Estimate maintenance calories (e.g. from bodyweight and activity), then recommend a deficit of ~300-500 kcal/day')
    } else if (goal.type === 'bulk') {
      lines2.push('Estimate maintenance calories (e.g. from bodyweight and activity), then recommend a surplus of ~200-400 kcal/day')
    } else {
      lines2.push('Estimate maintenance calories and recommend eating at approximately that level')
    }
    lines2.push('Set daily protein (0.7-1g per lb / 1.6-2.2g per kg bodyweight), then fats (~25-30% kcal) and carbs for the remainder, aligned with the coaching philosophy')
    lines2.push('When body-weight trend data is provided, compare actual change rate to the target rate and recommend a specific calorie adjustment if off pace')
    lines.push(`Current bodyweight on file: ${bw} ${settings.units} (~${Math.round(bwKg)} kg)`)
    lines.push(...lines2)
  } else {
    lines.push(`Goal: ${goal.type}. Bodyweight not on file — ask the user to log it or set it in Settings before making precise calorie recommendations.`)
  }
  return lines.join('\n')
}

export function compileMetrics(metrics: DailyMetric[], settings: Settings, days = 28): string {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const recent = metrics.filter((m) => m.date >= cutoff)
  if (recent.length === 0) return ''
  const lines = [`\n# HEALTH METRICS (last ${days} days)`]
  const w = recent.filter((m) => m.weight != null)
  if (w.length >= 2) {
    lines.push(`Weight: ${w[0].weight}${settings.units} → ${w[w.length - 1].weight}${settings.units} over ${w[0].date}..${w[w.length - 1].date} (${w.length} entries)`)
  }
  const bf = recent.filter((m) => m.bodyFat != null)
  if (bf.length >= 2) {
    lines.push(`Body fat: ${bf[0].bodyFat}% → ${bf[bf.length - 1].bodyFat}%`)
  }
  const s = recent.filter((m) => m.steps != null)
  if (s.length) {
    const avg = s.reduce((sum, m) => sum + (m.steps ?? 0), 0) / s.length
    lines.push(`Steps: avg ${Math.round(avg)}/day (${s.length} days with data)`)
  }
  const sl = recent.filter((m) => m.sleepMin != null)
  if (sl.length) {
    const avg = sl.reduce((sum, m) => sum + (m.sleepMin ?? 0), 0) / sl.length
    lines.push(`Sleep: avg ${(avg / 60).toFixed(1)}h/night (${sl.length} days with data)`)
  }
  return lines.join('\n')
}
