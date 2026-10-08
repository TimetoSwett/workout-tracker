/** The alert that marks the end of a rest, and an honest report of what went out.
 *
 *  The board felt and heard nothing when a rest ended on their phone. The old code called
 *  `navigator.vibrate(400)` and nothing else, which cannot make a sound at all and silently
 *  no-ops in several ordinary situations: a Capacitor WebView whose host app does not hold
 *  `android.permission.VIBRATE`, a page that has never had a user gesture, a page that is not
 *  visible, or a device with no vibrator. A single ignored call looked identical to a working
 *  one, so there was nothing to debug from.
 *
 *  So the alert now has two device channels and tells the caller which of them it managed to
 *  deliver:
 *
 *    - a short two-note chime through WebAudio, unlocked by the tap that started the rest;
 *    - a vibration pattern with gaps, which registers in the hand far better than one flat
 *      buzz of the same length.
 *
 *  The caller is expected to add a third, always-available channel on top: `LogView` shows a
 *  toast on every expiry and says plainly when neither device channel could be delivered,
 *  rather than leaving the user to guess whether the timer even ended.
 *
 *  Nothing here fires while the app is backgrounded or the screen is locked. Both channels
 *  need a foreground page in practice, that has not been verified on the board's phone, and a
 *  true background alarm needs a native notification or alarm instead of a web API. */

export type AlertOutcome = {
  sound: 'played' | 'blocked' | 'unsupported'
  vibration: 'sent' | 'blocked' | 'unsupported'
}

/** Two notes a fifth apart, the second longer: short enough not to be a nuisance between
 *  sets, pitched high enough to carry on a phone speaker in a noisy room. */
const NOTES = [
  { hz: 880, delay: 0, seconds: 0.16 },
  { hz: 1318.5, delay: 0.17, seconds: 0.28 },
]

/** Gaps, not one long buzz. Android renders a flat 400ms pulse as a vague hum that is easy to
 *  miss with the phone on a bench; three separated pulses are unmistakable. */
const PATTERN = [120, 70, 120, 70, 360]

type AudioCtor = typeof AudioContext

let ctx: AudioContext | null = null

function audioCtor(): AudioCtor | null {
  const w = window as typeof window & { webkitAudioContext?: AudioCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export function soundSupported(): boolean {
  return audioCtor() !== null
}

export function vibrationSupported(): boolean {
  return typeof navigator.vibrate === 'function'
}

/** Call this from inside a user gesture — the tap that completes a set, or the Settings test
 *  button. Autoplay policy only lets an `AudioContext` start running off a real interaction;
 *  once it is running it stays running, so the chime can fire later on a bare timer with no
 *  gesture of its own. Safe to call on every tap: the context is created once. */
export function armRestAlert(): void {
  const Ctor = audioCtor()
  if (!Ctor) return
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      ctx = null
      return
    }
  }
  // `resume()` resolves asynchronously, so this gesture may not have unlocked the context yet
  // when it returns. That is fine — the next gesture tries again, and `chime()` reports
  // `blocked` rather than pretending a sound was made.
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
}

/** Whether a chime would be heard right now, as far as the page can tell. */
export function soundReady(): boolean {
  return ctx !== null && ctx.state === 'running'
}

export function playRestAlert(): AlertOutcome {
  return { sound: chime(), vibration: buzz() }
}

function chime(): AlertOutcome['sound'] {
  if (!audioCtor()) return 'unsupported'
  const c = ctx
  if (!c) return 'blocked'
  if (c.state !== 'running') {
    // Suspended again — the system does this when the page loses focus. Ask for it back for
    // next time, but do not claim this alert was audible.
    void c.resume().catch(() => {})
    return 'blocked'
  }
  try {
    const t0 = c.currentTime
    for (const note of NOTES) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'triangle'
      osc.frequency.value = note.hz
      const start = t0 + note.delay
      const end = start + note.seconds
      // Ramped at both ends: a square-edged gain change is an audible click on a phone speaker,
      // and `exponentialRampToValueAtTime` cannot ramp to a true zero.
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.5, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain).connect(c.destination)
      osc.onended = () => {
        osc.disconnect()
        gain.disconnect()
      }
      osc.start(start)
      osc.stop(end + 0.02)
    }
    return 'played'
  } catch {
    return 'blocked'
  }
}

function buzz(): AlertOutcome['vibration'] {
  if (typeof navigator.vibrate !== 'function') return 'unsupported'
  try {
    // `false` means the browser refused it: no vibrator, a hidden page, or no user activation
    // in this page session. An Android WebView without the VIBRATE permission returns `true`
    // and does nothing, which is why the toast never depends on this answer alone.
    return navigator.vibrate(PATTERN) ? 'sent' : 'blocked'
  } catch {
    return 'blocked'
  }
}

/** One line for the Settings test row. Says what happened, not what should have happened. */
export function describeOutcome(o: AlertOutcome): string {
  const sound = {
    played: 'Chime played',
    blocked: 'Chime blocked by the browser',
    unsupported: 'No audio support',
  }[o.sound]
  const vibration = {
    sent: 'buzz sent',
    blocked: 'buzz refused',
    unsupported: 'no vibration support',
  }[o.vibration]
  const caveat =
    o.vibration === 'sent' ? ' — a sent buzz is not proof the phone moved' : ''
  return `${sound} · ${vibration}${caveat}`
}
