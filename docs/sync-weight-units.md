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
metrics. Review every record and select its known original unit. Mixed-unit files
require individual selections; unknown means leave unresolved. Cancel by leaving
the screen. No write occurs during review.

“Back up raw file and save selected units” first writes an immutable create-only
copy in the existing Dropbox app folder, named `<path>.before-units-<uuid>.jsonl`.
If backup fails, migration does not run. It appends only a `weightUnit` property
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
