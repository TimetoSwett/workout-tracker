import { useEffect, useState } from 'preact/hooks'
import type { DailyMetric } from '../types'
import { useStore } from '../store'
import { getMetrics, subscribeMetrics, upsertMetric } from '../metricsStore'
import { syncMetrics } from '../metricsSync'

function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function window(metrics: DailyMetric[], days: number, pick: (m: DailyMetric) => number | undefined): { date: string; value: number }[] {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  return metrics.filter((m) => m.date >= cutoff && pick(m) != null).map((m) => ({ date: m.date, value: pick(m)! }))
}

function avg(points: { value: number }[]): number | null {
  if (!points.length) return null
  return points.reduce((s, p) => s + p.value, 0) / points.length
}

export function BodyView() {
  const { settings } = useStore()
  const [, force] = useState(0)
  const [toast, setToast] = useState('')
  const [wRange, setWRange] = useState(365)
  const [manualDate, setManualDate] = useState(new Date().toISOString().slice(0, 10))
  const [manualWeight, setManualWeight] = useState('')
  const [manualBf, setManualBf] = useState('')

  useEffect(() => subscribeMetrics(() => force((n) => n + 1)), [])
  useEffect(() => {
    if (settings.dropboxToken) syncMetrics()
  }, [])

  const metrics = getMetrics()
  const u = settings.units

  const weightPts = window(metrics, wRange, (m) => m.weight)
  const bfPts = window(metrics, wRange, (m) => m.bodyFat)
  const stepsPts = window(metrics, 14, (m) => m.steps)
  const sleepPts = window(metrics, 14, (m) => m.sleepMin)

  const latest = [...metrics].reverse().find((m) => m.weight != null)
  const latestLean = [...metrics].reverse().find((m) => m.leanMass != null)
  const wAvgNow = avg(weightPts.slice(-7))
  const wAvgPrev = avg(weightPts.slice(-14, -7))
  const wTrend = wAvgNow != null && wAvgPrev != null ? wAvgNow - wAvgPrev : null

  const stepsAvg = avg(stepsPts)
  const sleepAvg = avg(sleepPts)

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  function saveManual() {
    const w = parseFloat(manualWeight)
    const bf = parseFloat(manualBf)
    if (!Number.isFinite(w) || w <= 0) return flash('Enter a valid weight')
    const existing = metrics.find((m) => m.date === manualDate)
    upsertMetric({
      date: manualDate,
      weight: Math.round(w * 10) / 10,
      bodyFat: Number.isFinite(bf) && bf > 0 ? Math.round(bf * 10) / 10 : undefined,
      muscle: existing?.muscle,
      steps: existing?.steps,
      sleepMin: existing?.sleepMin,
      updatedAt: Date.now(),
      source: 'manual',
    })
    setManualWeight('')
    setManualBf('')
    flash('Saved ✓')
    if (settings.dropboxToken) syncMetrics()
  }

  const noData = metrics.length === 0

  return (
    <div class="view">
      <h1>Body</h1>

      {noData && (
        <div class="card">
          <p>No health data yet.</p>
          <p class="muted small">
            Import your Samsung Health data (Settings → Import), or log weight manually below. Steps/sleep come
            in from Samsung Health exports.
          </p>
        </div>
      )}

      {latest && (
        <div class="card stat-row">
          <div>
            <div class="stat-num">
              {fmt(latest.weight!)} {u}
            </div>
            <div class="stat-label">weight · {latest.date}</div>
          </div>
          {latest.bodyFat != null && (
            <div>
              <div class="stat-num">{fmt(latest.bodyFat)}%</div>
              <div class="stat-label">body fat</div>
            </div>
          )}
          {latestLean && (
            <div>
              <div class="stat-num">
                {fmt(latestLean.leanMass!)} {u}
              </div>
              <div class="stat-label">lean mass</div>
            </div>
          )}
          {wTrend != null && (
            <div>
              <div class="stat-num" style={{ color: wTrend < 0 ? '#6ba8ff' : 'var(--accent)' }}>
                {wTrend > 0 ? '+' : ''}
                {fmt(wTrend)}
              </div>
              <div class="stat-label">7d vs prior ({u})</div>
            </div>
          )}
        </div>
      )}

      {(weightPts.length > 1 || bfPts.length > 1) && (
        <div class="card">
          <div class="setting-row" style={{ justifyContent: 'flex-end' }}>
            <div class="seg">
              <button class={wRange === 90 ? 'active' : ''} onClick={() => setWRange(90)}>
                90d
              </button>
              <button class={wRange === 365 ? 'active' : ''} onClick={() => setWRange(365)}>
                1y
              </button>
              <button class={wRange === 3650 ? 'active' : ''} onClick={() => setWRange(3650)}>
                All
              </button>
            </div>
          </div>
          {weightPts.length > 1 && <LineChart title={`Weight trend (${u})`} points={weightPts} />}
          {bfPts.length > 1 && <LineChart title="Body fat %" points={bfPts} />}
        </div>
      )}

      <div class="card">
        <h3>Log weight</h3>
        <div class="setting-row">
          <input
            class="set-input"
            type="date"
            value={manualDate}
            onInput={(e) => setManualDate((e.target as HTMLInputElement).value)}
            style={{ flex: 1 }}
          />
          <input
            class="set-input narrow"
            type="number"
            inputMode="decimal"
            placeholder={u}
            value={manualWeight}
            onInput={(e) => setManualWeight((e.target as HTMLInputElement).value)}
          />
          <input
            class="set-input narrow"
            type="number"
            inputMode="decimal"
            placeholder="%"
            value={manualBf}
            onInput={(e) => setManualBf((e.target as HTMLInputElement).value)}
          />
          <button class="btn primary small" onClick={saveManual}>
            Save
          </button>
        </div>
      </div>

      {stepsPts.length > 0 && <BarChart title="Steps (14d)" points={stepsPts} avg={stepsAvg} suffix=" steps" />}
      {sleepPts.length > 0 && <BarChart title="Sleep (14d)" points={sleepPts.map((p) => ({ ...p, value: p.value / 60 }))} avg={sleepAvg != null ? sleepAvg / 60 : null} suffix=" h" />}

      {toast && <div class="toast visible">{toast}</div>}
    </div>
  )
}

function LineChart({ title, points }: { title: string; points: { date: string; value: number }[] }) {
  const vals = points.map((p) => p.value)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const w = 100
  const h = 100
  const path = points
    .map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p.value - min) / range) * h}`)
    .join(' ')
  return (
    <div class="card">
      <h3>{title}</h3>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" class="line-chart">
        <polyline points={path} fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="chart-label muted">
        {points[0].date} → {points[points.length - 1].date} · {points.length} entries
      </div>
    </div>
  )
}

function BarChart({ title, points, avg, suffix }: { title: string; points: { date: string; value: number }[]; avg: number | null; suffix: string }) {
  const max = Math.max(...points.map((p) => p.value), 1)
  return (
    <div class="card">
      <h3>
        {title} {avg != null && <span class="muted">· avg {fmt(avg)}{suffix}</span>}
      </h3>
      <div class="chart">
        {points.map((p) => (
          <div key={p.date} class="chart-col" title={`${p.date}: ${fmt(p.value, 0)}${suffix}`}>
            <div class="chart-bar-wrap">
              <div class="chart-bar" style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
