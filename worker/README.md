# Backup sync API (Cloudflare Worker)

A second sync target alongside Dropbox (`src/dropbox.ts` / `src/sync.ts` in the
app). Stores the same four JSONL files — `workouts.jsonl`, `mesocycles.jsonl`,
`metrics.jsonl`, `coach.jsonl` — as rows in a D1 database, behind an
owner-only bearer token, with conditional writes so a stale client can't
clobber a newer file.

D1 over R2: the app already merges records itself on the client (see
`merge()` in `src/sync.ts`); the Worker only ever needs whole-file get/put
plus a version check. R2 objects + their ETag would give that for free and
were the original choice, but this account's R2 subscription was never
enabled in the Cloudflare dashboard — a one-time manual step
(`R2 → Enable R2`) with no API equivalent (`POST .../r2/buckets` returns
error `10042 NotEntitled` until it's done), which blocked provisioning the
bucket for an unattended deploy. D1 needs no such enablement step, so this
uses a single `files` table (one row per file: `name`, `content`, `etag`,
`size`, `uploaded_at`) with the same whole-file semantics — a conditional
`UPDATE ... WHERE etag = ?` standing in for R2's `onlyIf`. If you'd rather
use R2: enable it in the dashboard, then only `src/index.ts`'s storage calls
need to change — the HTTP API is unaffected.

## API

All routes require `Authorization: Bearer <API_TOKEN>` except `OPTIONS`
(CORS preflight). Without it, every route returns `401`.

| Method | Path            | Purpose                                             |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/files`        | List the four files with `etag` (`null` if absent), `size`, `uploadedAt` |
| GET    | `/files/:name`  | Fetch one file's content. `404` if it doesn't exist yet. `ETag` response header. |
| PUT    | `/files/:name`  | Write one file's content (raw body = file contents). |

`:name` is one of `workouts`, `mesocycles`, `metrics`, `coach`.

### Conditional writes

- Writing a file that doesn't exist yet: send the `PUT` with no `If-Match` —
  it's created.
- Writing a file that already exists: you must send `If-Match: <etag>` using
  the `ETag` you last read (from a `GET` or from `/files`). If you omit it,
  you get `428 Precondition Required`. If the value you send doesn't match
  the current object, you get `412 Precondition Failed` with the *current*
  `etag` in the JSON body — re-fetch, merge, and retry.
- `If-None-Match: *` on an existing file returns `409 Conflict` (refuses to
  overwrite) if you want a strict "create, never update" write.

This mirrors optimistic concurrency in the app already — the client
downloads, merges by record id, then uploads — just enforced at the file
level too so two devices racing to sync can't silently drop one's writes.

## Auth: bearer token, not Cloudflare Access

The task gave two options. This uses a long random bearer token pasted into
the app's Settings, not Cloudflare Access, because Access needs a Zero Trust
team domain and an Access application configured per environment (web +
Capacitor Android), which is meaningfully more setup for a single-owner app.
The token path needs one `wrangler secret put` and pasting the same string
into Settings. Access remains a reasonable upgrade later — swap the
`requireAuth` check in `src/index.ts` for Access JWT verification (the
`Cf-Access-Jwt-Assertion` header) without changing the rest of the API.

## CORS

`ALLOWED_ORIGINS` in `wrangler.toml` is a comma-separated allowlist. It ships
with the current GitHub Pages origin and Capacitor's default Android WebView
origins. Add the Cloudflare app origin once that host is chosen and
update/redeploy.

## Deployed

Live at `https://workout-tracker-sync.tuckerswett.workers.dev`. This Worker,
its D1 database (schema migrated), and its `API_TOKEN` secret were
provisioned and deployed directly through the connected Cloudflare API
(account `670bd9fabd96b1e7188896d7f3efdc14`, "Tuckerswett@pm.me's Account")
— no Owner action needed for the base deploy. `wrangler deploy` uploads code
but does not apply D1 migrations by itself; after adding a migration, also
run `npm run migrate:remote` (see "Local dev" below for the local
equivalent) so the schema in production matches what the Worker expects —
this deploy's `0001_create_files.sql` was applied this way. The token value
itself is never printed in a comment, doc, or transcript — see "Rotate or
retrieve the token" below.

## Owner setup (optional)

You only need to do any of this if you want to manage the Worker yourself
going forward instead of through the connected API — e.g. to rotate the
token, change the schema, or redeploy after edits.

1. **Install dependencies** (from this `worker/` directory):
   ```sh
   npm install
   ```
2. **Log in to Cloudflare:**
   ```sh
   npx wrangler login
   ```
   This opens a browser to authorize `wrangler` against your account.
3. **Rotate or retrieve the token:** the deploy already set `API_TOKEN` as a
   Worker secret. To rotate it:
   ```sh
   openssl rand -hex 32          # generate a new value
   npx wrangler secret put API_TOKEN   # paste it when prompted
   ```
   Secret values can't be read back from Cloudflare once set (by design) —
   if you've lost the current token, rotate it and update the app's
   Settings with the new value once SWE-30 adds that UI.
4. **Redeploy after any code change:**
   ```sh
   npx wrangler deploy
   ```
   If the change added a D1 migration, also apply it to production —
   `deploy` does not do this for you:
   ```sh
   npm run migrate:remote
   ```
5. **Optional — custom domain** (e.g. `api.tucker-swett.com`): in the
   Cloudflare dashboard, go to the deployed Worker → **Settings → Domains &
   Routes → Add → Custom Domain**, and enter the hostname. Requires that
   domain's DNS to already be on Cloudflare.
6. **Paste the token and the Worker URL into the app's Settings** once the
   Cloudflare sync UI lands, so the app can authenticate.

### Verify it's live

Replace `<url>` and `<token>` with your values:

```sh
# refused without auth
curl -i https://<url>/files

# authorized list (should show all four files with etag: null before first sync)
curl -i -H "Authorization: Bearer <token>" https://<url>/files

# put + get a file
curl -i -X PUT -H "Authorization: Bearer <token>" --data '{"id":"1"}' https://<url>/files/workouts
curl -i -H "Authorization: Bearer <token>" https://<url>/files/workouts
```

## Local dev

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in a throwaway local token
npm run dev                      # wrangler dev on http://localhost:8787, uses a local D1 emulation
```

`wrangler dev` creates the local D1 database automatically but does not run
migrations for it. Apply the schema once per fresh local DB:

```sh
npm run migrate:local
```

`npm run typecheck` runs `tsc --noEmit`.
