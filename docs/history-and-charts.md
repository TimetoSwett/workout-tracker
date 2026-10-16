# Useful history and charts (v0.3.2)

Two records per lift instead of one, and daily charts whose detail is reachable on a
phone. Scope is History's Best lifts card and Body's Steps / Sleep / Calories charts.

## Two records, one eligibility rule

`Best lifts` used to show a single figure — the best estimated 1RM — with the set it came
from. That is a modelled number, and it is not the number the board usually means by "my
best deadlift". `350×8` estimates 443 and outranks `400×1`'s 413, so the row reported a set
120lb lighter than the heaviest bar ever moved, and nothing on screen said the figure was
modelled at all.

So there are now two figures, reduced independently in `src/records.ts`:

| Figure | Comparator | Tiebreak |
| --- | --- | --- |
| `est. 1RM` | `beatsRecord` — highest `estimate1RM` | earliest date, then heavier set |
| `heaviest` | `beatsWeightRecord` — highest weight | earliest date, then higher reps |

`liftRecords()` runs both over one pass of `scoringSets()`, so the two figures can never
disagree about which sets exist. Eligibility is unchanged and still `isScoringSet`: a
completed set with a real load and a real rep count. An un-ticked row, a `skipped` or
`pending` set, and a row missing a weight or reps score neither figure. A lift with no
eligible set is absent from the map rather than present with zeroes, which is what keeps it
off the list.

Both tiebreaks resolve to the earliest date before anything else, for the same reason:
a record belongs to the day it was first achieved, and a Dropbox merge reorders `workouts`.
Neither figure may depend on array order. `test/records.check.ts` asserts this by comparing
`liftRecords(hist)` against `liftRecords([...hist].reverse())`.

**The word "estimated" is at the number, not in the card blurb.** With one figure the blurb
was survivable. With a modelled figure and a measured one stacked on top of each other it
is not — they are indistinguishable otherwise.

### Why the row stacks

The row is out of horizontal room and was already losing. At 360px `.pr-row` is 302px wide
and the *single* old value block measured 200.6px, so all five rows wrapped to a second
line unintentionally. A second figure with its own provenance makes that three lines. The
`.pr-row.stacked` variant makes the stack deliberate — name on its own line, both figures
beneath with their labels in a fixed-width column so the two numbers line up — rather than
letting the browser decide where to break. Plain `.pr-row` is untouched and Activity's
`45 min` rows still render on one line.

## Charts

- **Every bar is a control.** A `.chart-col` in the Body charts is a `<button>` with an
  `aria-label` and a visible focus ring. It used to be a `div` whose only detail was a
  native `title=` tooltip, which needs a hover the board's phone does not have — the
  reading was unreachable on the only device that matters. Arrow keys walk the selection
  and the focus together.
- **The selected reading is also written out in text**, above the chart, so the detail is
  legible without hitting a 30px bar at all. The newest reading starts selected, which also
  stops the card reflowing on the first tap.
- **Ticks get room rather than being thinned.** `.chart-label` resolves to 9.92px and the
  widest `M/D` tick (`12/28`) measures 24.8px. Calories fills the whole window, so 15
  columns in a 302px card would leave 14.5px each. `.chart-scroll` lets the track overflow
  past a 30px per-column floor and opens scrolled to the newest reading. Charts that fit —
  History's 8-column weekly volume, a sparse Sleep week — never scroll, because `.chart-col`
  still grows to fill.
- **Gaps are stated, not drawn.** `window()` already omitted a day with no reading rather
  than plotting it as zero, and that is unchanged. But the survivors are drawn equidistant,
  so the x-axis is *not* a time axis: a 7-day gap and a 1-day gap look identical. Nobody
  could see this before because there were no dates; with ticks the jump is visible. Rather
  than zero-fill (which the acceptance criteria forbid) or space columns by date, each
  chart now says what it is showing — `6 readings in the last 14 days · days with no
  reading are left out, not shown as zero` — and the titles no longer claim `(14d)` over a
  bar-per-reading axis.

Tick text is derived by splitting the stored `YYYY-MM-DD`, never by parsing it through
`Date`: `new Date('2026-09-27')` is UTC midnight and renders as the previous day west of
Greenwich. See `src/dates.ts`.

## Data and recovery

This batch is read-only with respect to storage. No schema change, no migration, no new
persisted field, and no write path touched — `liftRecords` is a pure derivation over
`workouts`, and the charts re-render existing `DailyMetric` rows. Recovery is therefore a
code revert with no data consequence, which is the one case where reverting app code *is*
sufficient. Web recovery still has to account for the service-worker cache; Szass Tam owns
that path.

No new network calls, endpoints, analytics or telemetry.

## QA

`tests/tom43-history-charts.qa.mjs` is the regression gate: it drives headless Chromium at
360px and 390px against synthetic storage and exits non-zero on a failure. It covers both
reductions and their provenance, the `est` label, every exclusion rule, exact-tie order
independence, per-column tick width against the measured font, focusability and accessible
names, the readout following a tap and an arrow key, gap omission, no horizontal page
overflow, and the empty-history and single-reading cases.

`tests/tom44-chart-baseline.qa.mjs` (The Soulmonger's pre-implementation baseline, always
exits 0) stood at 16 ok / 26 gaps before this batch and stands at 40 ok / 2 gaps after. The
two remaining are its `AC-layout … fits name and value on one line` check at each width —
that is the stacked-row decision above, taken deliberately, not a regression.

Device verification is The Soulmonger's. Nothing here touches `android/` or the Health
Connect plugin, so no Android compile is implicated.

## Version reconciliation

Shipped repository tags are v0.1.0, v0.2.0, v0.3.0 and v0.3.1. `v0.3.2` is this batch's
roadmap label, not a published release, and nothing in the repo hard-codes it: Settings and
the APK both derive their label from `scripts/app-version.mjs` (exact tag when the build is
tagged, otherwise date plus commit SHA). The package's `1.0.0` remains package metadata, not
an app label. Szass Tam owns candidate builds and versioning; no tag or infrastructure
change is included here.
