# Cloudflare preview navigation checks

Measured 2026-10-05 for TOM-19. Browser-style deep-link requests already receive
the SPA entry point on the existing previews. No routing change is required.

## Reproduce the distinction

A plain HTTP GET is not a browser navigation. Cloudflare documents SPA fallback
for requests carrying `Sec-Fetch-Mode: navigate`:
[SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

| Host | Root GET | Deep-link GET | Deep link with navigation header |
| --- | --- | --- | --- |
| ci-preview-probe-workout-tracker.tuckerswett.workers.dev | 200 | 404 | 200 |
| ci-cloudflare-preview-config-workout-tracker.tuckerswett.workers.dev | not remeasured | 404 | 200 |
| workout-tracker.tuckerswett.workers.dev | 200 | 200 | 200 |
| workout.tucker-swett.com | 200 | not remeasured | 200 |

Deep link: `/some/client/route`. Each deployment was queried independently.
These results establish HTTP fallback behavior, not overall production health
or physical-device verification. The reason production also answers plain GETs
was not established; the remaining non-navigation difference is real.

The probe preview was built successfully from
[`4d839497709a6d92e600b94f0b8395cef34f047b`](https://github.com/TimetoSwett/workout-tracker/commit/4d839497709a6d92e600b94f0b8395cef34f047b),
before the experimental `_redirects` change:
[Cloudflare build check](https://github.com/TimetoSwett/workout-tracker/runs/111821861349).
Its `/preview-probe.txt` returned the expected branch marker.
Root and navigation deep-link bodies were both 804 bytes with SHA-256
`062e0e9cbbd622ab08ca3e1e82cd12fffd3d7c22cfa76a25803be18bc67cbeae`.
The independently measured production root/deep-link bodies matched each other
at SHA-256 `a450baf3f3307737936c8275c9e31c1ea1829ee3df07f68bfae0740fb533a632`.
Different deployments need not have identical HTML hashes.

## QA procedure

Use a preview URL associated with a successful build of the intended commit.
To check origin fallback without a service worker:

```sh
preview_url=https://ci-preview-probe-workout-tracker.tuckerswett.workers.dev
probe_dir=$(mktemp -d)
curl --fail-with-body --silent --show-error \
  -H 'Sec-Fetch-Mode: navigate' "$preview_url/" -o "$probe_dir/root.html"
curl --fail-with-body --silent --show-error \
  -H 'Sec-Fetch-Mode: navigate' "$preview_url/some/client/route" -o "$probe_dir/route.html"
cmp "$probe_dir/root.html" "$probe_dir/route.html"
```

Both requests must return 200 and `cmp` must succeed. A plain curl 404 does not
prove browser deep links are broken. Fetch/XHR behavior should be tested
separately, without pretending those requests are navigations.

For browser verification, The Soulmonger should open the deep link directly in
a fresh browser context with no installed service worker, reload it, and confirm
the app renders with its JS/CSS assets loaded. The HTTP check above has been
performed; that browser check is a separate QA step.

## Configuration and scope

Keep `assets` at the top level. The pinned Wrangler 4.145.0 schema does not
permit `previews.assets`, but that alone does not mean preview asset settings
are ignored. Cloudflare explicitly places assets at the top level in its
[preview configuration guide](https://developers.cloudflare.com/workers/previews/configuration/#what-goes-in-the-previews-block).

Do not merge the `ci/preview-spa-fallback` experiment's `public/_redirects`
or diagnostic probe as a fix. Its two later builds
[failed](https://github.com/TimetoSwett/workout-tracker/runs/111823000934)
and [failed again](https://github.com/TimetoSwett/workout-tracker/runs/111825719336);
neither proves that redirect rule deployed. The existing successful probe is
sufficient to demonstrate navigation fallback.

This investigation changes documentation only. It changes no production
behavior, compatibility date, Wrangler pin, dashboard setting, signing,
versioning, release tag, or deployment workflow.
