#!/usr/bin/env node
// Single source of truth for the version of a build: the Android versionCode /
// versionName, and the string the web app shows in Settings. Everything that
// needs a version asks this module so the number on the phone always matches
// the artifact that is running.
//
//   versionCode  seconds between 2020-01-01 and the commit's committer date.
//                Derived from the commit, so re-running a build produces the
//                same number; strictly increasing as commits are made, so
//                Android always sees a newer build as an upgrade. ~2.1e8 today,
//                well under Android's 2100000000 ceiling (good past 2080).
//   versionName  a v* tag without its leading 'v' ("1.2.0") when building a
//                tag, otherwise <commit date>.<short sha> ("2026.09.29.a1b2c3d")
//                so an untagged build on the phone names its own commit.
//
// Override either value with the APP_VERSION_CODE / APP_VERSION_NAME env vars.
// CI computes the pair once and exports them so the web bundle and the APK
// cannot disagree.
//
// Usage:
//   node scripts/app-version.mjs           # JSON
//   node scripts/app-version.mjs --env     # KEY=value lines (for $GITHUB_ENV)
//   node scripts/app-version.mjs --check   # exit 1 unless the version came from git

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** versionCode 1 / a name that says so, for a tree with no usable git metadata. */
const FALLBACK = { versionCode: 1, versionName: '0.0.0-nogit', fromGit: false }

const EPOCH_2020 = 1577836800

function git(args) {
  return execFileSync('git', args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** The v* tag being built, or '' when this is not a tag build. */
function tagName() {
  // On GitHub Actions the ref is authoritative and needs no fetched tags.
  if (process.env.GITHUB_REF_TYPE === 'tag') return process.env.GITHUB_REF_NAME ?? ''
  try {
    return git(['describe', '--exact-match', '--tags', 'HEAD'])
  } catch {
    return ''
  }
}

export function appVersion() {
  const envCode = process.env.APP_VERSION_CODE
  const envName = process.env.APP_VERSION_NAME
  if (envCode && envName) {
    const versionCode = Number(envCode)
    if (!Number.isInteger(versionCode) || versionCode < 1) {
      throw new Error(`APP_VERSION_CODE must be a positive integer, got ${JSON.stringify(envCode)}`)
    }
    return { versionCode, versionName: envName, fromGit: false }
  }

  let committedAt
  let shortSha
  try {
    committedAt = Number(git(['log', '-1', '--format=%ct']))
    shortSha = git(['rev-parse', '--short=7', 'HEAD'])
  } catch {
    return FALLBACK
  }
  if (!Number.isFinite(committedAt) || !shortSha) return FALLBACK

  const versionCode = Math.max(1, committedAt - EPOCH_2020)
  const tag = tagName()
  // Tracked-file edits only: an untracked scratch file does not change the build.
  let dirty = false
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''
  } catch {
    // Leave dirty false; a repo that cannot report status still builds.
  }

  const date = new Date(committedAt * 1000).toISOString().slice(0, 10).replaceAll('-', '.')
  const base = tag ? tag.replace(/^v/, '') : `${date}.${shortSha}`
  return { versionCode, versionName: dirty ? `${base}.dirty` : base, fromGit: true }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const v = appVersion()
  const mode = process.argv[2] ?? '--json'
  if (mode === '--check' && !v.fromGit) {
    console.error(
      `app-version: no git metadata and no APP_VERSION_* override - would ship ${v.versionName} (versionCode ${v.versionCode})`,
    )
    process.exit(1)
  }
  if (mode === '--env' || mode === '--check') {
    console.log(`APP_VERSION_CODE=${v.versionCode}`)
    console.log(`APP_VERSION_NAME=${v.versionName}`)
  } else {
    console.log(JSON.stringify({ versionCode: v.versionCode, versionName: v.versionName }))
  }
}
