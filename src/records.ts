import type { LoggedSet, Workout } from './types'

/** Did the user actually perform this set?
 *
 *  `done` is the only completion flag any write path sets: `LogView` toggles it from the
 *  ✓ button, `mesoEngine` seeds generated rows with `done: false`, and `rpImport` derives
 *  it from the upstream set status. A set-level `status` of `'skipped'` or `'pending'`
 *  (what `mapSetStatus` assigns to an imported set that was planned but never finished)
 *  is rejected too, so a plan row can never be mistaken for a finished one.
 *
 *  Finishing a workout keeps every row that has a weight or a rep count typed into it,
 *  completed or not, so this check is the only thing separating a real set from an
 *  abandoned or mistyped one. */
export function isCompletedSet(s: LoggedSet): boolean {
  if (s.status === 'skipped' || s.status === 'pending') return false
  return s.done === true
}

/** Can this set hold a record? Completed, with a real load and a real rep count — an
 *  estimated 1RM taken off a null or zero weight is 0 and ranks nothing.
 *
 *  Every site that ranks sets by estimated 1RM must use this one predicate. They used to
 *  carry three different rules, and the loosest of them let a set typed into the Log but
 *  never ticked become an all-time max, both in Best lifts and in the coach's prompt. */
export function isScoringSet(s: LoggedSet): boolean {
  return isCompletedSet(s) && (s.weight ?? 0) > 0 && (s.reps ?? 0) > 0
}

/** Does this set count as work performed — a hard set, in the coach's terms?
 *
 *  Any load. A bodyweight Pull-Up carries `weight: 0` or `weight: null` and can hold no
 *  record (`isScoringSet` rejects it — an estimated 1RM off no load is 0), but it is real
 *  effort and counts here. The only questions are whether the user did the set and whether
 *  it had reps; a row with no reps is a plan, not work.
 *
 *  This is the one effort rule. Volume, set counts, the coach's hard-set totals and its
 *  rep-bucket mix all run off it, so the number on a workout card and the number in the
 *  prompt cannot disagree. */
export function isHardSet(s: LoggedSet): boolean {
  return isCompletedSet(s) && (s.reps ?? 0) > 0
}

/** Does this session contribute training data at all? A workout marked skipped does not,
 *  even if its rows kept their numbers, and neither does a tombstoned one.
 *
 *  The session-level rule is shared: a skipped session holds no records *and* reports no
 *  volume, sets or shape data. Only the set-level rule splits in two, into `isScoringSet`
 *  for records and `isHardSet` for effort. */
export function isScoringWorkout(w: Workout): boolean {
  return !w.deleted && w.status !== 'skipped'
}

/** Record-eligible sets of `workouts`, paired with the exercise and date they belong to. */
export function* scoringSets(workouts: Workout[]): Generator<{ name: string; set: LoggedSet; date: string }> {
  for (const w of workouts) {
    if (!isScoringWorkout(w)) continue
    for (const ex of w.exercises) {
      for (const set of ex.sets) {
        if (isScoringSet(set)) yield { name: ex.name, set, date: w.date }
      }
    }
  }
}

/** Epley. Kept here so every record and trend figure in the app uses one formula. */
export function estimate1RM(weight: number, reps: number): number {
  return weight * (1 + reps / 30)
}

export interface RecordSet {
  weight: number
  reps: number
  e1rm: number
  /** Omitted when every candidate comes from the same session, where it cannot decide anything. */
  date?: string
}

/** Does `cand` take the record from `best`?
 *
 *  The tiebreak is fixed rather than left to array order: `300×5` and `250×12` both come
 *  to exactly 350, and whichever the loop saw first used to win. A Dropbox merge reorders
 *  `workouts`, so the date shown next to a record silently changed after a sync.
 *
 *  Higher estimated 1RM wins. An exact tie goes to the earliest date — a record belongs to
 *  the day it was first achieved — and then to the heavier set, which is the measured half
 *  of the estimate. Sets that agree on all three are the same set. */
export function beatsRecord(cand: RecordSet, best: RecordSet | undefined): boolean {
  if (!best) return true
  if (cand.e1rm !== best.e1rm) return cand.e1rm > best.e1rm
  if (cand.date != null && best.date != null && cand.date !== best.date) return cand.date < best.date
  return cand.weight > best.weight
}

/** Does `cand` take the *heaviest weight* record from `best`?
 *
 *  A second, independent ranking — not a field read off the `beatsRecord` winner. The two
 *  records genuinely disagree: `350×8` estimates 443 and so outranks `400×1`'s 413, but 400
 *  is the heavier bar the user actually moved. "Most weight I have ever lifted" is a
 *  measured fact and has to be reduced on its own terms.
 *
 *  Heavier weight wins. An exact tie goes to the earliest date, for the same reason
 *  `beatsRecord` does — a record belongs to the day it was first achieved — and then to the
 *  higher rep count, which is the harder of two sets at one load. Sets that agree on all
 *  three are interchangeable. Eligibility is still `isScoringSet` via `scoringSets`, so the
 *  two figures can never disagree about which sets exist. */
export function beatsWeightRecord(cand: RecordSet, best: RecordSet | undefined): boolean {
  if (!best) return true
  if (cand.weight !== best.weight) return cand.weight > best.weight
  if (cand.date != null && best.date != null && cand.date !== best.date) return cand.date < best.date
  return cand.reps > best.reps
}

export interface LiftRecords {
  /** Highest estimated 1RM. Modelled by `estimate1RM`, never measured — label it as such
   *  wherever it is shown next to `heaviest`, or the two numbers are indistinguishable. */
  e1rm: RecordSet
  /** Heaviest weight actually moved. Often, but not always, a different set from `e1rm`. */
  heaviest: RecordSet
}

/** Both records for every exercise with at least one record-eligible set, keyed by name.
 *
 *  One pass over one eligibility rule, two reductions. Exercises with no eligible set are
 *  absent rather than present with zeroes, so an empty history yields an empty map and a
 *  lift whose every set is missing a weight or a rep count never appears. */
export function liftRecords(workouts: Workout[]): Map<string, LiftRecords> {
  const out = new Map<string, LiftRecords>()
  for (const { name, set, date } of scoringSets(workouts)) {
    const cand: RecordSet = {
      weight: set.weight!,
      reps: set.reps!,
      date,
      e1rm: estimate1RM(set.weight!, set.reps!),
    }
    const cur = out.get(name)
    out.set(name, {
      e1rm: beatsRecord(cand, cur?.e1rm) ? cand : cur!.e1rm,
      heaviest: beatsWeightRecord(cand, cur?.heaviest) ? cand : cur!.heaviest,
    })
  }
  return out
}
