import { useState } from 'preact/hooks'
import type { LoggedSet, Mesocycle, Workout } from '../types'
import { commitPastEdit, dayMarkers, monthGrid, workoutsOnLocalDate } from '../calendar'
import { localDate } from '../dates'
import { canStartPlanned, plannedForRange } from '../schedule'
import { getState, upsertWorkout } from '../store'
import { sync } from '../sync'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function clock(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function numOrNull(v: string): number | null {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function copyWorkout(w: Workout): Workout {
  return {
    ...w,
    exercises: w.exercises.map((ex) => ({ ...ex, sets: ex.sets.map((s) => ({ ...s })) })),
    ...(w.activity ? { activity: { ...w.activity } } : {}),
  }
}

export function LogCalendar({
  workouts,
  units,
  activeId,
  dropbox,
  meso,
  onStartPlanned,
}: {
  workouts: Workout[]
  units: string
  activeId?: string
  dropbox: boolean
  /** The active plan; only its schedule is shown as planned days. */
  meso?: Mesocycle | null
  /** Starts the plan's next session like the normal start. Omitted while a workout is open. */
  onStartPlanned?: () => void
}) {
  const today = localDate()
  const now = new Date()
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(now.getFullYear())
  const [monthIndex, setMonthIndex] = useState(now.getMonth())
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Workout | null>(null)

  const cells = monthGrid(year, monthIndex)
  const planned = plannedForRange(meso, workouts, today, cells[0].date, cells[cells.length - 1].date)
  const markers = dayMarkers(workouts, { planned })
  const plannedOnSelected = selected ? planned.filter((p) => p.date === selected) : []
  // Only the plan's next session can be started: that is what the normal start flow begins.
  const nextSlot = plannedForRange(meso, workouts, today, today, '9999-12-31')[0]?.slot
  const sessions = selected ? workoutsOnLocalDate(workouts, selected) : []
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  function shiftMonth(by: number) {
    const d = new Date(year, monthIndex + by, 1)
    setYear(d.getFullYear())
    setMonthIndex(d.getMonth())
    setDraft(null)
  }

  function pickDay(date: string) {
    setSelected(date)
    setDraft(null)
  }

  function patchSet(exIdx: number, setIdx: number, patch: Partial<LoggedSet>) {
    setDraft((w) =>
      w
        ? {
            ...w,
            exercises: w.exercises.map((ex, i) =>
              i === exIdx ? { ...ex, sets: ex.sets.map((s, j) => (j === setIdx ? { ...s, ...patch } : s)) } : ex,
            ),
          }
        : w,
    )
  }

  function saveDraft() {
    if (!draft) return
    const original = getState().workouts.find((w) => w.id === draft.id && !w.deleted)
    if (!original || original.id === activeId) return
    upsertWorkout(commitPastEdit(original, draft, Date.now()))
    setDraft(null)
    if (dropbox) sync()
  }

  return (
    <div class="card cal">
      <button
        class="btn ghost wide"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          setDraft(null)
        }}
      >
        {open ? 'Hide calendar' : 'Calendar'}
      </button>
      {open && (
        <>
          <div class="cal-head">
            <button class="icon-btn" type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
              ‹
            </button>
            <span>{monthLabel}</span>
            <button class="icon-btn" type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>
              ›
            </button>
          </div>
          <div class="cal-weekdays" aria-hidden="true">
            {WEEKDAYS.map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div class="cal-grid">
            {cells.map((cell) => {
              const m = markers.get(cell.date)
              const count = m?.done ?? 0
              const parts = [
                count > 0 ? `${count} done` : '',
                m && m.skipped > 0 ? `${m.skipped} skipped` : '',
                m && m.planned > 0 ? 'planned' : '',
              ].filter(Boolean)
              const classes = [
                'cal-day',
                cell.inMonth ? '' : 'out',
                cell.date === today ? 'today' : '',
                cell.date === selected ? 'selected' : '',
                count > 0 ? 'has' : '',
                m && m.skipped > 0 ? 'skipped' : '',
                m && m.planned > 0 ? 'planned' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <button
                  key={cell.date}
                  type="button"
                  class={classes}
                  aria-label={`${cell.date}, ${parts.length > 0 ? parts.join(', ') : 'no workouts'}`}
                  aria-pressed={cell.date === selected}
                  onClick={() => pickDay(cell.date)}
                >
                  {Number(cell.date.slice(8))}
                </button>
              )
            })}
          </div>
          {selected && (
            <div>
              <div class="history-date">{formatDay(selected)}</div>
              {sessions.length === 0 && plannedOnSelected.length === 0 && (
                <p class="muted small">No workout logged this day.</p>
              )}
              {meso &&
                !draft &&
                plannedOnSelected.map((p) => {
                  const day = meso.days[p.dayIndex]
                  const canStart = canStartPlanned(p.date, today) && p.slot === nextSlot
                  return (
                    <div key={p.slot} class="past-session planned-session">
                      <div class="workout-title">{p.label ?? day?.label ?? 'Workout'} (planned)</div>
                      <div class="muted small">
                        {meso.name} · Week {p.week + 1}/{meso.weeksPlanned}, day {p.dayIndex + 1}
                      </div>
                      {day && day.exercises.length > 0 && (
                        <div class="muted small">{day.exercises.map((ex) => `${ex.name} ×${ex.sets}`).join(' · ')}</div>
                      )}
                      {canStart && onStartPlanned ? (
                        <button class="btn small primary" type="button" onClick={onStartPlanned}>
                          Start this
                        </button>
                      ) : (
                        <p class="muted small">
                          {canStart ? 'Finish the open workout to start this.' : 'Planned for later. You can start it on the day.'}
                        </p>
                      )}
                    </div>
                  )
                })}
              {draft ? (
                <div>
                  <p class="muted small">Editing this saved workout. The one you have open is left alone.</p>
                  {draft.activity && (
                    <label class="setting-row">
                      <span>Minutes</span>
                      <input
                        class="set-input narrow"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        value={draft.activity.durationMin}
                        onInput={(e) => {
                          const n = parseInt((e.target as HTMLInputElement).value, 10)
                          if (!Number.isFinite(n) || n < 0 || !draft.activity) return
                          const activity = draft.activity
                          setDraft({ ...draft, activity: { ...activity, durationMin: n } })
                        }}
                      />
                    </label>
                  )}
                  {draft.exercises.map((ex, exIdx) => (
                    <div key={ex.id} class="past-session">
                      <div class="exercise-name">{ex.name}</div>
                      {ex.sets.map((s, setIdx) => (
                        <div key={setIdx} class="set-row">
                          <span class="set-num">{setIdx + 1}</span>
                          <input
                            class="set-input"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            aria-label={`${ex.name} set ${setIdx + 1} weight`}
                            value={s.weight ?? ''}
                            onInput={(e) => patchSet(exIdx, setIdx, { weight: numOrNull((e.target as HTMLInputElement).value) })}
                          />
                          <input
                            class="set-input"
                            type="number"
                            inputMode="numeric"
                            min="0"
                            aria-label={`${ex.name} set ${setIdx + 1} reps`}
                            value={s.reps ?? ''}
                            onInput={(e) => patchSet(exIdx, setIdx, { reps: numOrNull((e.target as HTMLInputElement).value) })}
                          />
                          <button
                            class={`icon-btn ${s.done ? 'success' : ''}`}
                            type="button"
                            aria-label={`${ex.name} set ${setIdx + 1} ${s.done ? 'completed' : 'not completed'}`}
                            onClick={() => patchSet(exIdx, setIdx, { done: !s.done })}
                          >
                            ✓
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div class="btn-row">
                    <button class="btn primary" type="button" onClick={saveDraft}>
                      Save
                    </button>
                    <button class="btn ghost" type="button" onClick={() => setDraft(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                sessions.map((w) => (
                  <div key={w.id} class="past-session">
                    <div class="workout-title">{w.name ?? w.activity?.type ?? 'Workout'}</div>
                    <div class="muted small">
                      {clock(w.startedAt)}
                      {w.activity ? ` · ${w.activity.durationMin} min` : ''}
                      {w.exercises.length > 0 ? ` · ${w.exercises.map((ex) => ex.name).join(' · ')}` : ''}
                    </div>
                    {w.id !== activeId && (
                      <button class="btn small ghost" type="button" onClick={() => setDraft(copyWorkout(w))}>
                        Edit
                      </button>
                    )}
                  </div>
                ))
              )}
              {sessions.length > 1 && !draft && (
                <p class="muted small">{sessions.length} sessions this day.</p>
              )}
            </div>
          )}
          <p class="muted small cal-legend">
            <span class="cal-key done" aria-hidden="true" /> done · <span class="cal-key" aria-hidden="true">×</span>{' '}
            skipped · <span class="cal-key planned" aria-hidden="true" /> planned
          </p>
          <p class="muted small">Weights are in {units}. Opening a day does not log anything.</p>
        </>
      )}
    </div>
  )
}
