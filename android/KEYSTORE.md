# Release keystore

The release signing key is **not** in this repo. It lives on this machine at:

```
~/.android/workout-tracker/release.jks
```

Its passwords and alias are in `android/keystore.properties` (gitignored,
sits next to this file, never committed). That file was generated once with:

```
keytool -genkeypair -v \
  -keystore ~/.android/workout-tracker/release.jks \
  -alias workout-tracker \
  -keyalg RSA -keysize 2048 -validity 10000
```

`android/app/build.gradle` reads `keystore.properties` at build time and signs
the `release` build type with it. If `keystore.properties` is missing, the
release build falls back to **unsigned** instead of failing, so CI/dev
machines without the key can still build.

## If you need to re-create it elsewhere

1. Copy `android/keystore.properties.example` to `android/keystore.properties`.
2. Generate (or copy) a `.jks` keystore and point `storeFile` at its absolute
   path.
3. Fill in `storePassword`, `keyAlias`, `keyPassword` to match.
4. Back up the `.jks` file somewhere safe (e.g. a password manager attachment
   or encrypted storage) - **losing it means you can never publish an update
   under the same app signature again.** Since this app is sideloaded (not on
   the Play Store), that just means reinstalling instead of updating in place,
   but keeping the key lets you update normally.

## Signing APKs built on GitHub Actions

`.github/workflows/android-apk.yml` builds the APK on GitHub. To have it sign
with this release key, add four repository secrets. Do this yourself on the
machine that holds the `.jks`. Never paste these values into an issue or chat.

1. Base64-encode the keystore (single line, no wrapping):

   ```sh
   base64 -w0 ~/.android/workout-tracker/release.jks > release.jks.b64   # Linux
   base64 -i ~/.android/workout-tracker/release.jks -o release.jks.b64   # macOS
   ```

2. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, and add:

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | contents of `release.jks.b64` |
   | `ANDROID_KEYSTORE_PASSWORD` | `storePassword` from `keystore.properties` |
   | `ANDROID_KEY_ALIAS` | `keyAlias` from `keystore.properties` |
   | `ANDROID_KEY_PASSWORD` | `keyPassword` from `keystore.properties` |

   Or with the GitHub CLI, from the repo directory:

   ```sh
   gh secret set ANDROID_KEYSTORE_BASE64 < release.jks.b64
   gh secret set ANDROID_KEYSTORE_PASSWORD   # prompts, input hidden
   gh secret set ANDROID_KEY_ALIAS
   gh secret set ANDROID_KEY_PASSWORD
   ```

3. Delete `release.jks.b64` (`shred -u release.jks.b64` on Linux).

The workflow decodes the keystore into the runner's temp dir, writes a
`keystore.properties` for the build, and deletes both at the end of the job.
If any of the four secrets is missing, it builds a **debug-signed** APK instead
(artifact name ends in `-debug-signed`). That APK installs, but it will not
update over a release-signed install. You would have to uninstall first, which
wipes on-device app data.

## Never

- Never commit `*.jks`, `*.keystore`, or `keystore.properties` (all
  gitignored already).
- Never paste the store/key passwords into an issue, PR, or chat.
