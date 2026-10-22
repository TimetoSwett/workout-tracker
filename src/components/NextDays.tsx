import type { Mesocycle, Workout } from '../types'
import { localDate } from '../dates'
import { nextDays } from '../schedule'

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Today through the next six days: what the active plan expects, plus anything already logged. */
export function NextDays({ meso, workouts }: { meso: Mesocycle | null; workouts: Workout[] }) {
  const today = localDate()
  const days = nextDays(meso, workouts, today)
  if (!days.some((d) => d.planned.length > 0)) return null
  return (
    <div class="card">
      <h3>Next 7 days</h3>
      <ul class="next-days">
        {days.map((d) => {
          const parts = [
            ...d.planned.map((p) => `${p.label ?? 'Workout'} (planned)`),
            d.done > 0 ? `${d.done} done` : '',
            d.skipped > 0 ? `${d.skipped} skipped` : '',
          ].filter(Boolean)
          return (
            <li key={d.date}>
              <span>{d.date === today ? 'Today' : formatDay(d.date)}</span>
              <span class={parts.length > 0 ? '' : 'muted'}>{parts.length > 0 ? parts.join(' · ') : 'Rest'}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
