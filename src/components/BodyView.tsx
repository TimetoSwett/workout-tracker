import { useEffect, useRef, useState } from 'preact/hooks'
import type { DailyMetric } from '../types'
import { useStore } from '../store'
import { getMetrics, subscribeMetrics, upsertMetric } from '../metricsStore'
import { syncMetrics } from '../metricsSync'
import { dropboxConfigured } from '../dropbox'
import { localDate, localDateDaysAgo } from '../dates'
import { kgToUnits } from '../units'

// Same bounds healthImport.ts already enforces on imported rows, so a typed reading and
// an imported one are held to one standard.
const WEIGHT_MIN_KG = 20
const WEIGHT_MAX_KG = 400
const BF_MIN = 1
const BF_MAX = 70

/** The window the daily charts (resting HR, steps, sleep, calories) look back over. Shared
 *  with the caption each chart prints, so the number shown is the number filtered on. */
const RECENT_DAYS = 14

function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function window(metrics: DailyMetric[], days: number, pick: (m: DailyMetric) => number | undefined): { date: string; value: number }[] {
  const cutoff = localDateDaysAgo(days)
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
  const [manualDate, setManualDate] = useState(localDate())
  const [manualWeight, setManualWeight] = useState('')
  const [manualBf, setManualBf] = useState('')

  useEffect(() => subscribeMetrics(() => force((n) => n + 1)), [])
  useEffect(() => {
    if (dropboxConfigured(settings)) syncMetrics()
  }, [])

  const metrics = getMetrics()
  const u = settings.units

  const weightPts = window(metrics, wRange, (m) => m.weight)
  const bfPts = window(metrics, wRange, (m) => m.bodyFat)
  const hrPts = window(metrics, RECENT_DAYS, (m) => m.restingHr)
  const stepsPts = window(metrics, RECENT_DAYS, (m) => m.steps)
  const sleepPts = window(metrics, RECENT_DAYS, (m) => m.sleepMin)
  const caloriesPts = window(metrics, RECENT_DAYS, (m) => m.calories)

  const latest = [...metrics].reverse().find((m) => m.weight != null)
  const latestLean = [...metrics].reverse().find((m) => m.leanMass != null)
  const latestNutrition = [...metrics].reverse().find((m) => m.calories != null)
  const wAvgNow = avg(weightPts.slice(-7))
  const wAvgPrev = avg(weightPts.slice(-14, -7))
  const wTrend = wAvgNow != null && wAvgPrev != null ? wAvgNow - wAvgPrev : null

  const latestHr = [...metrics].reverse().find((m) => m.restingHr != null)
  const hrAvg = avg(hrPts)
  const stepsAvg = avg(stepsPts)
  const sleepAvg = avg(sleepPts)
  const caloriesAvg = avg(caloriesPts)

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  function saveManual() {
    const wMin = kgToUnits(WEIGHT_MIN_KG, u)
    const wMax = kgToUnits(WEIGHT_MAX_KG, u)
    const w = parseFloat(manualWeight)
    if (!Number.isFinite(w) || w < wMin || w > wMax) {
      return flash(`Enter a weight between ${fmt(wMin, 0)} and ${fmt(wMax, 0)} ${u}`)
    }
    // Body fat is optional, but a value that was typed and is unusable must say so
    // rather than flash "Saved ✓" and drop it.
    let bodyFat: number | undefined
    if (manualBf.trim() !== '') {
      const bf = parseFloat(manualBf)
      if (!Number.isFinite(bf) || bf < BF_MIN || bf > BF_MAX) {
        return flash(`Body fat must be between ${BF_MIN} and ${BF_MAX}%`)
      }
      bodyFat = Math.round(bf * 10) / 10
    }
    // Only the fields being set are passed: upsertMetric merges onto the stored day, and
    // sending `bodyFat: undefined` used to erase a reading the board had already logged.
    upsertMetric({
      date: manualDate,
      weight: Math.round(w * 10) / 10,
      bodyFat,
      updatedAt: Date.now(),
      source: 'manual',
    })
    setManualWeight('')
    setManualBf('')
    flash('Saved ✓')
    if (dropboxConfigured(settings)) syncMetrics()
  }

  const noData = metrics.length === 0

  return (
    <div class="view cols">
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

      {latestNutrition && (
        <div class="card stat-row">
          <div>
            <div class="stat-num">{fmt(latestNutrition.calories!, 0)}</div>
            <div class="stat-label">calories · {latestNutrition.date}</div>
          </div>
          {latestNutrition.proteinG != null && (
            <div>
              <div class="stat-num">{fmt(latestNutrition.proteinG, 0)}g</div>
              <div class="stat-label">protein</div>
            </div>
          )}
          {latestNutrition.carbsG != null && (
            <div>
              <div class="stat-num">{fmt(latestNutrition.carbsG, 0)}g</div>
              <div class="stat-label">carbs</div>
            </div>
          )}
          {latestNutrition.fatG != null && (
            <div>
              <div class="stat-num">{fmt(latestNutrition.fatG, 0)}g</div>
              <div class="stat-label">fat</div>
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

      {latestHr && (
        <div class="card">
          <div class="stat-row">
            <div>
              <div class="stat-num">{fmt(latestHr.restingHr!, 0)}</div>
              <div class="stat-label">resting HR · {latestHr.date}</div>
            </div>
            {hrAvg != null && (
              <div>
                <div class="stat-num">{fmt(hrAvg, 0)}</div>
                <div class="stat-label">{RECENT_DAYS}d avg (bpm)</div>
              </div>
            )}
          </div>
          {hrPts.length > 1 && <LineChart title="Resting HR (bpm)" points={hrPts} />}
        </div>
      )}

      <div class="card">
        <h3>Log weight</h3>
        {/* The date picker is the widest control here and it does not shrink, so it gets
            its own row; all four on one row measured 411px at a 390px viewport and pushed
            Save off-screen. See `.weigh-in-row`. */}
        <div class="setting-row">
          <input
            class="set-input"
            type="date"
            value={manualDate}
            onInput={(e) => setManualDate((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="setting-row weigh-in-row">
          <input
            class="set-input"
            type="number"
            inputMode="decimal"
            placeholder={u}
            value={manualWeight}
            onInput={(e) => setManualWeight((e.target as HTMLInputElement).value)}
          />
          <input
            class="set-input"
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

      {/* The window is stated in each chart's caption now, together with how many readings
          actually landed in it, so the titles no longer claim "(14d)" over a bar per
          reading. See `BarChart`. */}
      {stepsPts.length > 0 && (
        <BarChart title="Steps" points={stepsPts} avg={stepsAvg} suffix=" steps" days={RECENT_DAYS} />
      )}
      {sleepPts.length > 0 && (
        <BarChart
          title="Sleep"
          points={sleepPts.map((p) => ({ ...p, value: p.value / 60 }))}
          avg={sleepAvg != null ? sleepAvg / 60 : null}
          suffix=" h"
          days={RECENT_DAYS}
          digits={1}
        />
      )}
      {caloriesPts.length > 0 && (
        <BarChart title="Calories" points={caloriesPts} avg={caloriesAvg} suffix=" kcal" days={RECENT_DAYS} />
      )}

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

/** `M/D` from a stored local-calendar `YYYY-MM-DD`. Split rather than parsed through
 *  `Date`, because `new Date('2026-09-27')` is parsed as UTC midnight and renders as the
 *  previous day anywhere west of Greenwich — the exact trap `dates.ts` exists to avoid. */
function tick(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** A dated bar chart whose detail is reachable without a mouse.
 *
 *  Three things this is careful about:
 *
 *  - **Every bar is a real control.** It used to be a `div` whose only detail was a native
 *    `title=` tooltip, which needs a hover the board's phone does not have; the reading was
 *    unreachable on the only device that matters. Each column is now a button with an
 *    accessible name, and the selected reading is also written out in text above the chart
 *    so touch, mouse and keyboard all land somewhere.
 *  - **Ticks get room rather than colliding.** The Calories chart fills the whole window,
 *    and 15 columns in a 302px card leaves 14.5px each while the widest `12/28` tick
 *    measures 24.8px. `.chart-scroll` lets the track overflow past a per-column floor
 *    instead, and starts scrolled to the newest reading.
 *  - **Gaps are stated, not drawn.** A day with no reading is omitted upstream in
 *    `window()`, never plotted as zero. That means the survivors are equidistant and the
 *    x-axis is *not* a time axis, so the caption says how many readings these are rather
 *    than implying one bar per day. */
function BarChart({
  title,
  points,
  avg,
  suffix,
  days,
  digits = 0,
}: {
  title: string
  points: { date: string; value: number }[]
  avg: number | null
  suffix: string
  days: number
  digits?: number
}) {
  const max = Math.max(...points.map((p) => p.value), 1)
  // The newest reading starts selected: it is the one the board is looking for, and a
  // readout that is always present cannot reflow the card on the first tap.
  const [sel, setSel] = useState(points.length - 1)
  const track = useRef<HTMLDivElement>(null)
  // Clamp rather than trust: a sync or an import can shorten `points` under a stale index.
  const i = Math.min(Math.max(sel, 0), points.length - 1)
  const cur = points[i]

  // Newest is rightmost, so an overflowing track opens on the wrong end by default.
  useEffect(() => {
    const el = track.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [points.length])

  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = Math.min(points.length - 1, Math.max(0, i + step))
    setSel(next)
    // Move focus with the selection, or a keyboard user's focus ring and the highlighted
    // bar drift apart. `onFocus` would re-select the same index, which is a no-op.
    const cols = (e.currentTarget as HTMLElement).children
    ;(cols[next] as HTMLElement | undefined)?.focus()
  }

  return (
    <div class="card">
      <h3>
        {title} {avg != null && <span class="muted">· avg {fmt(avg)}{suffix}</span>}
      </h3>
      <div class="chart-readout">
        <span class="chart-readout-val">
          {fmt(cur.value, digits)}
          {suffix}
        </span>
        <span class="muted"> · {cur.date}</span>
      </div>
      <div class="chart-scroll" ref={track}>
        <div class="chart" role="group" aria-label={`${title}, ${points.length} readings`} onKeyDown={onKeyDown}>
          {points.map((p, n) => (
            <button
              key={p.date}
              type="button"
              class={`chart-col${n === i ? ' selected' : ''}`}
              aria-label={`${p.date}: ${fmt(p.value, digits)}${suffix}`}
              aria-pressed={n === i}
              onClick={() => setSel(n)}
              onFocus={() => setSel(n)}
            >
              <div class="chart-bar-wrap">
                <div class="chart-bar" style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }} />
              </div>
              <span class="chart-label">{tick(p.date)}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="muted small">
        {points.length} {points.length === 1 ? 'reading' : 'readings'} in the last {days} days · days with no
        reading are left out, not shown as zero
      </div>
    </div>
  )
}
