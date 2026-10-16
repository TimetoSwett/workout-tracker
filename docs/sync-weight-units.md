# Weight sync and legacy recovery

Wire `weightUnit` names the unit of that record's numbers. Upload adds a tag,
without converting or rounding. Same-unit reads retain exact numeric values;
cross-unit reads round to the existing 0.1 local display precision. Unchanged
remote records keep their original wire values even when another record uploads.
Offline unit conversion keeps its existing behavior.

Unknown or invalid remote units pause the affected sync before local writes or
uploads. No receiving-device setting is used to infer legacy provenance. An
already incorrectly tagged measurement from an earlier version cannot be
automatically identified: compare against a known original/backup.

## Explicit legacy resolution

Settings → Dropbox sync → Resolve legacy weight units → Review workouts/body
metrics. Review every record and select its known original unit. If you know all unlabeled
records were entered in pounds, use “I entered all unlabeled records in pounds
(lb)” to select lbs for this reviewed file, then save. This choice is never inferred
from display preferences and never applied globally to other users. Explicit kg
labels remain untouched and are flagged for comparison with original backups. Mixed-unit files
require individual selections; unknown means leave unresolved. Cancel by leaving
the screen. No write occurs during review.

“Back up raw file and save selected units” first writes an immutable create-only
copy in the existing Dropbox app folder, named `<path>.before-units-<uuid>.jsonl`.
The backup is downloaded again and compared byte for byte before any original
file is replaced. If backup creation or recovery verification fails, migration
does not run. It appends only a `weightUnit` property
to each selected raw JSON line: 178.46 and 102.25 retain their exact numeric
literals, as do whitespace and unknown fields. It never guesses or converts.
Invalid tags and malformed JSON require recovery/review, not automatic repair.

Uploads use Dropbox revision-conditional update (or create-only for absent files),
with strict conflicts and no autorename. On a conflict, re-read and merge only
identical reviewed raw lines; preserve intervening tagged records. New/changed
unknown records require a fresh review. Competing unit declarations cannot replace
one another. Every revision replaced gets its own raw backup. At most three
attempts are made; continuous changes pause instead of overwriting.

After migration, sync again to import. For recovery, stop syncing other devices,
download both the named raw backup and current file from Dropbox, and compare
before replacing anything. The backup has the exact pre-migration contents.
Restoring it to the original path restores unknown-unit status and pauses sync;
then re-review units. Preserve intervening newer records rather than blindly
restoring a whole older snapshot. This change does not perform real-data recovery
or authorize a migration on the board's folder.

## Focused verification

`npm run check` covers all lbs/kg pairings, 178.46/102.25 precision, legacy unknown
and mixed units, raw backups/failure, competing migrators, intervening writes,
revision transport and offline conversion. Dropbox is simulated; no credentials
or actual health data are used. Independent QA owns browser regression and real
service/device verification; no Android compilation is claimed on this host.

## Logging comfort candidate verification

The timer occupies a dedicated row above a scrolling set editor. Its controls
start collapsed; Show/Hide controls changes only presentation, preserving the
absolute rest deadline. The logging viewport follows VisualViewport resize for
an open keyboard; navigation occupies its own row. The editor uses one column
at all widths to avoid horizontal fragmentation inside a bounded scroll area.

Independent QA: at 360px and 390px, desktop, portrait and landscape, start a
workout with several long exercise labels. Complete a set, scroll to the last
exercise, backfill a previous set, open the numeric keyboard, expand/collapse the
timer, add 30 seconds, change tabs and return. Assert the countdown persists and
no field, navigation, modal, or keyboard is covered. Check toast overlap, finish
feedback, empty/loading/error states, and no horizontal overflow. Browser viewport
resizing simulates reduced space but is not proof of Android keyboard behavior.

For units, use synthetic workouts and metrics with unlabeled 178.46 and 102.25,
explicit lbs/kg, malformed and invalid-unit records, concurrent edits, and a denied
or corrupted backup download. Assert exact raw recovery, unchanged measurements,
no writes on failure, successful sync after resolution, and safe repeated sync.
Do not use the board's data until its exports and recovery have been demonstrated.

Version reconciliation: existing repository tags are v0.1.0, v0.2.0, and v0.3.0.
The package's 1.0.0 is a package metadata value, not the shipped app label. Settings
and Android derive labels from scripts/app-version.mjs (exact tag, otherwise date
and commit SHA). v0.3.1 is this batch's roadmap label, not a published release.
Szass Tam owns candidate/recovery builds and versioning; no tag or infrastructure
change is included here.
