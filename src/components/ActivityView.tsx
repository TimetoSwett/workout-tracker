import { useMemo, useState } from 'preact/hooks'
import type { Workout } from '../types'
import { ACTIVITY_TYPES } from '../types'
import { getState, setWorkouts, uid, upsertWorkout, useStore } from '../store'
import { getMetrics, upsertMetric } from '../metricsStore'
import { sync } from '../sync'
import { syncMetrics } from '../metricsSync'
import { dropboxConfigured } from '../dropbox'
import { localDateDaysAgo } from '../dates'
import { editedActivity } from '../activityEdit'

function isoDate(offsetDays = 0): string {
  return localDateDaysAgo(offsetDays)
}

function prettyDate(iso: string): string {
  if (iso === isoDate(0)) return 'Today'
  if (iso === isoDate(1)) return 'Yesterday'
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ActivityView() {
  const { workouts, settings } = useStore()
  const [type, setType] = useState('Climbing')
  const [style, setStyle] = useState('Bouldering')
  const [minutes, setMinutes] = useState('')
  const [date, setDate] = useState(isoDate(0))
  const [note, setNote] = useState('')
  const [toast, setToast] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const [stepDate, setStepDate] = useState(isoDate(1))
  const [stepCount, setStepCount] = useState('')

  const selected = ACTIVITY_TYPES.find((a) => a.type === type)

  const recent = useMemo(() => {
    const all = workouts.filter((w) => w.activity).sort((a, b) => b.startedAt - a.startedAt)
    return showAll ? all : all.slice(0, 20)
  }, [workouts, showAll])
  const activityCount = useMemo(() => workouts.filter((w) => w.activity).length, [workouts])

  const metricFor = (d: string) => getMetrics().find((m) => m.date === d)

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  function saveActivity() {
    const mins = parseInt(minutes, 10)
    if (!Number.isFinite(mins) || mins <= 0) return flash('Enter a duration first')
    // Midday so the date can't slide across a timezone boundary.
    const startedAt = new Date(date + 'T12:00:00').getTime()
    const w: Workout = {
      id: uid(),
      date,
      startedAt,
      endedAt: startedAt + mins * 60000,
      name: selected?.styles ? `${type} — ${style}` : type,
      exercises: [],
      notes: note.trim() || undefined,
      updatedAt: Date.now(),
      status: 'complete',
      activity: { type, durationMin: mins, ...(selected?.styles ? { style } : {}) },
    }
    upsertWorkout(w)
    setMinutes('')
    setNote('')
    flash(`${w.name} · ${mins} min saved ✓`)
    if (dropboxConfigured(settings)) sync()
  }

  function saveSteps() {
    const n = parseInt(stepCount, 10)
    if (!Number.isFinite(n) || n < 0) return flash('Enter a step count first')
    const existing = metricFor(stepDate)
    upsertMetric({ ...existing, date: stepDate, steps: n, updatedAt: Date.now(), source: 'manual' })
    setStepCount('')
    flash(`${n.toLocaleString()} steps saved for ${prettyDate(stepDate)} ✓`)
    if (dropboxConfigured(settings)) syncMetrics()
  }

  function removeActivity(id: string) {
    if (!confirm('Delete this activity?')) return
    setWorkouts(getState().workouts.map((w) => (w.id === id ? { ...w, deleted: true, updatedAt: Date.now() } : w)))
    if (editingId === id) setEditingId(null)
    if (dropboxConfigured(settings)) sync()
  }

  function saveEdit(original: Workout, edit: { type: string; style?: string; durationMin: number; date: string; notes?: string }) {
    upsertWorkout(editedActivity(original, edit, Date.now()))
    setEditingId(null)
    flash('Activity updated ✓')
    if (dropboxConfigured(settings)) sync()
  }

  return (
    <div class="view cols">
      <h1>Activity</h1>

      <div class="card">
        <h3>Log a session</h3>
        <div class="activity-grid">
          {ACTIVITY_TYPES.map((a) => (
            <button
              key={a.type}
              class={`activity-chip ${type === a.type ? 'active' : ''}`}
              onClick={() => {
                setType(a.type)
                if (a.styles) setStyle(a.styles[0])
              }}
            >
              <span class="activity-icon">{a.icon}</span>
              {a.type}
            </button>
          ))}
        </div>

        {selected?.styles && (
          <div class="setting-row">
            <span>Style</span>
            <div class="seg">
              {selected.styles.map((s) => (
                <button key={s} class={style === s ? 'active' : ''} onClick={() => setStyle(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="setting-row">
          <span>Duration</span>
          <input
            class="set-input narrow"
            type="number"
            inputMode="numeric"
            min="1"
            value={minutes}
            onInput={(e) => setMinutes((e.target as HTMLInputElement).value)}
          />
          <span class="muted">min</span>
        </div>

        <div class="setting-row">
          <span>Date</span>
          <div class="seg">
            <button class={date === isoDate(0) ? 'active' : ''} onClick={() => setDate(isoDate(0))}>
              Today
            </button>
            <button class={date === isoDate(1) ? 'active' : ''} onClick={() => setDate(isoDate(1))}>
              Yesterday
            </button>
          </div>
        </div>
        <input
          class="text-input"
          type="date"
          value={date}
          onInput={(e) => setDate((e.target as HTMLInputElement).value)}
        />

        <input
          class="text-input"
          type="text"
          placeholder="Notes (optional) — gym, grades, how it felt"
          value={note}
          onInput={(e) => setNote((e.target as HTMLInputElement).value)}
        />
        <button class="btn primary wide" onClick={saveActivity}>
          Save activity
        </button>
      </div>

      <div class="card">
        <h3>Steps</h3>
        <p class="muted small">
          Manual entry until the Samsung link is reliable. Imported days are overwritten by the next
          Samsung import.
        </p>
        <div class="setting-row">
          <span>Date</span>
          <div class="seg">
            <button class={stepDate === isoDate(1) ? 'active' : ''} onClick={() => setStepDate(isoDate(1))}>
              Yesterday
            </button>
            <button class={stepDate === isoDate(0) ? 'active' : ''} onClick={() => setStepDate(isoDate(0))}>
              Today
            </button>
          </div>
        </div>
        <div class="setting-row">
          <span>Steps</span>
          <input
            class="set-input"
            style={{ maxWidth: 130 }}
            type="number"
            inputMode="numeric"
            min="0"
            placeholder={String(metricFor(stepDate)?.steps ?? 'e.g. 15000')}
            value={stepCount}
            onInput={(e) => setStepCount((e.target as HTMLInputElement).value)}
          />
          {metricFor(stepDate)?.steps != null && (
            <span class="muted small">on file: {metricFor(stepDate)!.steps!.toLocaleString()}</span>
          )}
        </div>
        <button class="btn wide" onClick={saveSteps}>
          Save steps
        </button>
      </div>

      {recent.length > 0 && (
        <div class="card">
          <h3>Recent activity</h3>
          {recent.map((w) =>
            editingId === w.id ? (
              <ActivityEditor key={w.id} workout={w} onCancel={() => setEditingId(null)} onSave={(edit) => saveEdit(w, edit)} />
            ) : (
              <div key={w.id} class="pr-row">
                <span>
                  {ACTIVITY_TYPES.find((a) => a.type === w.activity?.type)?.icon ?? '•'}{' '}
                  {w.activity?.style ? `${w.activity.type} — ${w.activity.style}` : w.activity?.type}
                  <span class="muted small"> · {prettyDate(w.date)}</span>
                  {w.notes && <div class="muted small">{w.notes}</div>}
                </span>
                <span class="pr-val">
                  {w.activity?.durationMin} min
                  <button class="btn small ghost" style={{ marginLeft: 8 }} type="button" onClick={() => setEditingId(w.id)}>
                    Edit
                  </button>
                  <button class="icon-btn danger" style={{ marginLeft: 8 }} type="button" aria-label={`Delete ${w.name ?? 'activity'}`} onClick={() => removeActivity(w.id)}>
                    ✕
                  </button>
                </span>
              </div>
            ),
          )}
          {!showAll && activityCount > recent.length && (
            <button class="btn ghost wide" type="button" onClick={() => setShowAll(true)}>
              Show all {activityCount}
            </button>
          )}
        </div>
      )}

      {toast && <div class="toast">{toast}</div>}
    </div>
  )
}

function ActivityEditor({
  workout,
  onCancel,
  onSave,
}: {
  workout: Workout
  onCancel: () => void
  onSave: (edit: { type: string; style?: string; durationMin: number; date: string; notes?: string }) => void
}) {
  const activity = workout.activity!
  const [type, setType] = useState(activity.type)
  const [style, setStyle] = useState(activity.style ?? '')
  const [minutes, setMinutes] = useState(String(activity.durationMin))
  const [date, setDate] = useState(workout.date)
  const [note, setNote] = useState(workout.notes ?? '')
  const [error, setError] = useState('')
  const selected = ACTIVITY_TYPES.find((a) => a.type === type)

  function chooseType(next: string) {
    const kind = ACTIVITY_TYPES.find((a) => a.type === next)
    setType(next)
    setStyle(kind?.styles?.includes(style) ? style : (kind?.styles?.[0] ?? ''))
  }

  function save() {
    const mins = parseInt(minutes, 10)
    if (!Number.isFinite(mins) || mins <= 0) {
      setError('Enter a duration first')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('Pick a date')
      return
    }
    onSave({ type, style: selected?.styles ? style : undefined, durationMin: mins, date, notes: note })
  }

  return (
    <div class="past-session">
      <div class="activity-grid">
        {ACTIVITY_TYPES.map((a) => (
          <button
            key={a.type}
            type="button"
            class={`activity-chip ${type === a.type ? 'active' : ''}`}
            onClick={() => chooseType(a.type)}
          >
            <span class="activity-icon">{a.icon}</span>
            {a.type}
          </button>
        ))}
      </div>
      {selected?.styles && (
        <div class="setting-row">
          <span>Style</span>
          <div class="seg">
            {selected.styles.map((s) => (
              <button key={s} type="button" class={style === s ? 'active' : ''} onClick={() => setStyle(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <div class="setting-row">
        <span>Duration</span>
        <input
          class="set-input narrow"
          type="number"
          inputMode="numeric"
          min="1"
          aria-label="Duration in minutes"
          value={minutes}
          onInput={(e) => setMinutes((e.target as HTMLInputElement).value)}
        />
        <span class="muted">min</span>
      </div>
      <input class="text-input" type="date" aria-label="Date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      <input
        class="text-input"
        type="text"
        placeholder="Notes (optional)"
        aria-label="Notes"
        value={note}
        onInput={(e) => setNote((e.target as HTMLInputElement).value)}
      />
      {error && <p class="muted small">{error}</p>}
      <div class="btn-row">
        <button class="btn primary" type="button" onClick={save}>
          Save
        </button>
        <button class="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
