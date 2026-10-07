/** Owns the rest deadline for the whole app, outside any view.
 *
 *  The expiry alert used to live in `LogView`, driven by that component's one-second
 *  `setInterval`. `app.tsx` renders tabs as `{tab === 'log' && <LogView />}`, so tapping
 *  History unmounted the component, stopped the interval and tore down the effect: a rest
 *  that ran out while the user was looking at any other tab never alerted at all. It alerted
 *  on the *return* to Log instead — a buzz at the one moment the user can already see the
 *  timer is done, and silence at the moment it mattered. QA measured exactly that on
 *  `387a371`.
 *
 *  So the clock moved here: one module-level timeout against the stored deadline, started
 *  once at app boot and kept in step with the store. Nothing about it depends on which tab
 *  is mounted. `LogView` still runs its own per-second tick, but only to paint the
 *  countdown; it no longer decides when a rest ends.
 *
 *  A single timeout, not a per-second poll: the deadline is a fixed timestamp, so there is
 *  nothing to poll for, and one wake-up per rest beats ninety.
 *
 *  This still does not fire with the app backgrounded or the screen locked — a frozen page
 *  runs no timers, and `setTimeout` only fires late, on resume. That case needs a native
 *  notification or alarm and is tracked separately; what this module guarantees is that a
 *  foreground rest alerts on time no matter where the user is in the app. */

import { getState, setActive, subscribe } from './store'
import { playRestAlert, type AlertOutcome } from './restAlert'

/** How late an expiry may be and still be worth announcing.
 *
 *  Two things make a timeout fire late: the page was frozen across the deadline (phone
 *  asleep, app backgrounded), or the deadline was already in the past when the app opened.
 *  Either way a chime minutes after the fact is noise — the user has long since moved on —
 *  but the stale deadline still has to be cleared. Past this window the rest is cleaned up
 *  in silence. */
const GRACE_MS = 30_000

export type RestDone = {
  /** When the rest ran out. */
  at: number
  outcome: AlertOutcome
}

let timer = 0
/** The deadline the pending timeout was scheduled for, so an unrelated store write does not
 *  cancel and re-arm a timer that is already correct. */
let armedFor: number | null = null
let started = false

let done: RestDone | null = null
const doneListeners = new Set<() => void>()

/** The last rest that ran out, or `null` once another rest starts or the workout ends.
 *  Survives tab switches, because the message is as useful on return as it was on expiry —
 *  more so when neither device channel could be delivered. */
export function restDone(): RestDone | null {
  return done
}

export function subscribeRestDone(fn: () => void): () => void {
  doneListeners.add(fn)
  return () => {
    doneListeners.delete(fn)
  }
}

function setDone(next: RestDone | null) {
  done = next
  for (const l of doneListeners) l()
}

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = 0
  armedFor = null
}

function expired(deadline: number) {
  timer = 0
  armedFor = null

  const current = getState().active?.restEndsAt
  // Skip, +30s or a finished workout may have landed between scheduling and firing. `sync()`
  // can also swap the active workout wholesale. Re-read rather than trusting the closure.
  if (current !== deadline) {
    arm()
    return
  }
  // Timers may fire a touch early, and a frozen page resumes with the deadline already past.
  const late = Date.now() - deadline
  if (late < 0) {
    arm()
    return
  }

  // Clear the total alongside the deadline: Skip already cleared both, so leaving it behind
  // on expiry stored a rest total with no rest attached to it.
  setActive({ ...getState().active!, restEndsAt: undefined, restTotal: undefined })
  if (late < GRACE_MS) setDone({ at: deadline, outcome: playRestAlert() })
}

/** Brings the timeout in line with the stored deadline. Idempotent, so it is safe to call on
 *  every store write. */
function arm() {
  const state = getState()
  const deadline = state.active?.restEndsAt
  // The last rest's line is stale the moment another rest starts or the workout goes away.
  // Cleared here rather than in the view so it does not depend on the Log tab being mounted
  // at the time. Note `expired` clears the deadline *before* it records the new outcome, so
  // this never wipes the message it is about to show.
  if (done && (!state.active || (deadline != null && deadline > Date.now()))) setDone(null)
  if (deadline == null) {
    clearTimer()
    return
  }
  if (armedFor === deadline) return
  clearTimer()
  armedFor = deadline
  // A deadline already in the past still needs its timeout: `expired` is the one place that
  // clears the stored rest, and it suppresses the alert itself once past the grace window.
  timer = setTimeout(() => expired(deadline), Math.max(0, deadline - Date.now())) as unknown as number
}

/** Start the watcher. Called once from app startup, before the first render, so a rest that
 *  is already running when the app opens is picked up whichever tab the user lands on. */
export function startRestWatch(): () => void {
  if (started) return () => {}
  started = true
  const unsubscribe = subscribe(arm)
  arm()
  return () => {
    unsubscribe()
    clearTimer()
    started = false
  }
}
