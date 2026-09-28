# Backup sync API (Cloudflare Worker)

A second sync target alongside Dropbox (`src/dropbox.ts` / `src/sync.ts` in the
app). Stores the same four JSONL files — `workouts.jsonl`, `mesocycles.jsonl`,
`metrics.jsonl`, `coach.jsonl` — in an R2 bucket, behind an owner-only bearer
token, with conditional writes so a stale client can't clobber a newer file.

R2 over D1: the app already merges records itself on the client (see `merge()`
in `src/sync.ts`); the Worker only ever needs whole-file get/put plus a
version check, which R2 objects + their ETag give for free. D1 would add a
schema and per-record writes nothing here needs.

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

## Owner setup (one-time)

You need your own Cloudflare account (free tier is enough — Workers + R2 both
have a free tier).

1. **Install dependencies** (from this `worker/` directory):
   ```sh
   npm install
   ```
2. **Log in to Cloudflare:**
   ```sh
   npx wrangler login
   ```
   This opens a browser to authorize `wrangler` against your account.
3. **Create the R2 bucket** (name must match `wrangler.toml`'s `bucket_name`):
   ```sh
   npx wrangler r2 bucket create workout-tracker-sync
   ```
4. **Generate a long random token** and save it somewhere safe (a password
   manager) — you'll paste it in two places:
   ```sh
   openssl rand -hex 32
   ```
5. **Store the token as a Worker secret** (paste the value from step 4 when
   prompted; it is never written to a file or the repo):
   ```sh
   npx wrangler secret put API_TOKEN
   ```
6. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   This prints the Worker's URL (`https://workout-tracker-sync.<your-subdomain>.workers.dev`
   by default).
7. **Optional — custom domain** (e.g. `api.tucker-swett.com`): in the
   Cloudflare dashboard, go to the deployed Worker → **Settings → Domains &
   Routes → Add → Custom Domain**, and enter the hostname. Requires that
   domain's DNS to already be on Cloudflare.
8. **Paste the token and the Worker URL into the app's Settings** once the
   Cloudflare sync UI lands — same token as step 4/5, so the app can
   authenticate.

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
npm run dev                      # wrangler dev on http://localhost:8787, uses a local R2 emulation
```

`npm run typecheck` runs `tsc --noEmit`.
