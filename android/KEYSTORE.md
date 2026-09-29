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

## Never

- Never commit `*.jks`, `*.keystore`, or `keystore.properties` (all
  gitignored already).
- Never paste the store/key passwords into an issue, PR, or chat.
