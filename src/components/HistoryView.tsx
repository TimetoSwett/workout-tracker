import { useMemo, useState } from 'preact/hooks'
import type { Workout } from '../types'
import { getState, setTemplates, uid, useStore } from '../store'
import { setWorkouts } from '../store'
import { sync } from '../sync'
import { durationMin, setCount, volumeOf } from '../prompts'

function startOfWeek(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  c.setDate(c.getDate() - c.getDay())
  return c
}

export function HistoryView() {
  const { workouts, settings, templates } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)

  const sorted = useMemo(() => [...workouts].sort((a, b) => b.startedAt - a.startedAt), [workouts])

  const weeks = useMemo(() => {
    const byWeek = new Map<string, number>()
    for (const w of workouts) {
      const key = startOfWeek(new Date(w.startedAt)).toISOString().slice(0, 10)
      byWeek.set(key, (byWeek.get(key) ?? 0) + volumeOf(w))
    }
    const out: { key: string; label: string; volume: number }[] = []
    const cur = startOfWeek(new Date())
    for (let i = 7; i >= 0; i--) {
      const d = new Date(cur)
      d.setDate(d.getDate() - i * 7)
      const key = d.toISOString().slice(0, 10)
      out.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, volume: byWeek.get(key) ?? 0 })
    }
    return out
  }, [workouts])

  const prs = useMemo(() => {
    const best = new Map<string, { weight: number; reps: number; date: string }>()
    for (const w of workouts) {
      for (const ex of w.exercises) {
        for (const s of ex.sets) {
          if (s.weight == null || s.reps == null || s.weight <= 0) continue
          const cur = best.get(ex.name)
          if (!cur || s.weight > cur.weight) {
            best.set(ex.name, { weight: s.weight, reps: s.reps, date: w.date })
          }
        }
      }
    }
    return [...best.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 8)
  }, [workouts])

  const maxVol = Math.max(1, ...weeks.map((w) => w.volume))

  function deleteWorkout(id: string) {
    if (!confirm('Delete this workout?')) return
    const existing = getState().workouts.find((w) => w.id === id)
    if (existing) {
      setWorkouts(getState().workouts.map((w) => (w.id === id ? { ...w, deleted: true, updatedAt: Date.now() } : w)))
    } else {
      setWorkouts(getState().workouts.filter((w) => w.id !== id))
    }
    if (settings.dropboxToken) sync()
  }

  function saveAsTemplate(w: Workout) {
    const name = prompt('Template name', w.name ?? '')?.trim()
    if (!name) return
    setTemplates([
      ...templates,
      { id: uid(), name, exercises: w.exercises.map((ex) => ({ name: ex.name, sets: ex.sets.length })) },
    ])
  }

  if (workouts.length === 0) {
    return (
      <div class="view">
        <h1>History</h1>
        <p class="muted">No workouts yet. Log your first one in the Log tab.</p>
      </div>
    )
  }

  return (
    <div class="view">
      <h1>History</h1>

      <div class="card">
        <h3>Weekly volume ({settings.units})</h3>
        <div class="chart">
          {weeks.map((w) => (
            <div key={w.key} class="chart-col" title={`${w.label}: ${Math.round(w.volume).toLocaleString()}`}>
              <div class="chart-bar-wrap">
                <div class="chart-bar" style={{ height: `${Math.max(2, (w.volume / maxVol) * 100)}%` }} />
              </div>
              <span class="chart-label">{w.label}</span>
            </div>
          ))}
        </div>
      </div>

      {prs.length > 0 && (
        <div class="card">
          <h3>Best lifts</h3>
          {prs.map(([name, pr]) => (
            <div key={name} class="pr-row">
              <span>{name}</span>
              <span class="pr-val">
                {pr.weight}
                {settings.units} × {pr.reps} <span class="muted">({pr.date})</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {sorted.map((w) => (
        <div key={w.id} class="card workout-card">
          <button class="workout-head" onClick={() => setOpenId(openId === w.id ? null : w.id)}>
            <div>
              <div class="workout-title">
                {w.name ?? 'Workout'} <span class="muted">· {w.date}</span>
              </div>
              <div class="muted small">
                {w.exercises.length} exercises · {setCount(w)} sets · {durationMin(w)} min ·{' '}
                {Math.round(volumeOf(w)).toLocaleString()} {settings.units} volume
              </div>
            </div>
            <span class="chevron">{openId === w.id ? '▾' : '▸'}</span>
          </button>
          {openId === w.id && (
            <div class="workout-detail">
              {w.exercises.map((ex) => (
                <div key={ex.id} class="detail-ex">
                  <div class="detail-ex-name">{ex.name}</div>
                  <div class="detail-sets">
                    {ex.sets.map((s, i) => (
                      <span key={i} class="set-badge">
                        {s.weight ?? '?'}×{s.reps ?? '?'}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <div class="detail-actions">
                <button class="btn small ghost" onClick={() => saveAsTemplate(w)}>
                  Save as template
                </button>
                <button class="btn small danger" onClick={() => deleteWorkout(w.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}