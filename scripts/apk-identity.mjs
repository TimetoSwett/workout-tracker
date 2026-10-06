#!/usr/bin/env node
// What is actually inside an APK: the version Android will report, and the key
// that signed it. Both answers matter before handing a build to the board:
//
//   versionCode   Android refuses an install whose code does not increase, so a
//                 recovery build has to out-number the candidate it replaces.
//   signer cert   an APK signed with a different key cannot update an installed
//                 app at all. It forces an uninstall, which deletes the data.
//
// `apksigner verify --print-certs` and `aapt2 dump badging` answer both, but
// they need the Android SDK and a JDK. The hosts this repo's agents run on have
// neither, which would leave every claim about a downloaded artifact resting on
// a CI log. This reads the APK bytes directly instead, so the artifact the board
// is about to install can be checked where it is downloaded.
//
// Values are the same numbers those tools print: the certificate digest matches
// apksigner's "certificate SHA-256 digest" line.
//
//   node scripts/apk-identity.mjs <apk>...
//   node scripts/apk-identity.mjs --json <apk>...
//
// Exits non-zero if an APK carries no v2/v3 signature (debug-signed-only or
// unsigned builds are v1-or-nothing and must not be mistaken for release ones).

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const APK_SIGNING_BLOCK_MAGIC = 'APK Sig Block 42'
/** APK Signature Scheme block ids. v1 (JAR signing) lives in META-INF instead. */
const SCHEMES = new Map([
  [0x7109871a, 'v2'],
  [0xf05368c0, 'v3'],
])

// ---------------------------------------------------------------- zip reading

/** Offset of the Central Directory, from the End of Central Directory record. */
function centralDirectoryOffset(buf) {
  // The EOCD is last, but a trailing comment may follow it. Scan back.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return buf.readUInt32LE(i + 16)
  }
  throw new Error('not a zip: no End of Central Directory record')
}

/** Every entry in the Central Directory, as { name, offset, method, size }. */
function entries(buf) {
  const out = new Map()
  let p = centralDirectoryOffset(buf)
  while (buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    out.set(name, { method, compressedSize, offset: buf.readUInt32LE(p + 42) })
    p += 46 + nameLength + extraLength + commentLength
  }
  return out
}

function read(buf, entry) {
  // Local file header: its name/extra lengths, not the central directory's.
  const nameLength = buf.readUInt16LE(entry.offset + 26)
  const extraLength = buf.readUInt16LE(entry.offset + 28)
  const start = entry.offset + 30 + nameLength + extraLength
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`unsupported zip compression method ${entry.method}`)
}

// ------------------------------------------------------------------- signing

/**
 * The APK Signing Block, which sits between the entry data and the Central
 * Directory. Its size is written at both ends so it can be found from either.
 */
function signingBlock(buf) {
  const cd = centralDirectoryOffset(buf)
  if (buf.toString('latin1', cd - 16, cd) !== APK_SIGNING_BLOCK_MAGIC) {
    throw new Error('no APK Signing Block - the APK is unsigned or v1-only')
  }
  const sizeAtEnd = Number(buf.readBigUInt64LE(cd - 24))
  const start = cd - 8 - sizeAtEnd
  if (Number(buf.readBigUInt64LE(start)) !== sizeAtEnd) {
    throw new Error('APK Signing Block size fields disagree')
  }
  return buf.subarray(start + 8, cd - 24)
}

/** The block's id -> value pairs, each length-prefixed. */
function* idValuePairs(block) {
  for (let p = 0; p + 12 <= block.length; ) {
    const length = Number(block.readBigUInt64LE(p))
    yield { id: block.readUInt32LE(p + 8), value: block.subarray(p + 12, p + 8 + length) }
    p += 8 + length
  }
}

/** A uint32-length-prefixed sequence of uint32-length-prefixed elements. */
function* lengthPrefixed(buf) {
  for (let p = 0; p + 4 <= buf.length; ) {
    const length = buf.readUInt32LE(p)
    yield buf.subarray(p + 4, p + 4 + length)
    p += 4 + length
  }
}

/** Every signer certificate in a v2/v3 signature block, DER-encoded. */
function* signerCertificates(value) {
  for (const signer of lengthPrefixed(value.subarray(4))) {
    const [signedData] = lengthPrefixed(signer)
    // signed data is: digests, certificates, additional attributes.
    const [, certificates] = [...lengthPrefixed(signedData)]
    yield* lengthPrefixed(certificates)
  }
}

// ----------------------------------------------------- binary AndroidManifest

const RES_STRING_POOL = 0x0001
const RES_XML_START_ELEMENT = 0x0102
const UTF8_FLAG = 1 << 8

function stringPool(chunk) {
  const count = chunk.readUInt32LE(8)
  const flags = chunk.readUInt32LE(16)
  const stringsStart = chunk.readUInt32LE(20)
  const out = []
  for (let i = 0; i < count; i++) {
    let p = stringsStart + chunk.readUInt32LE(28 + i * 4)
    if (flags & UTF8_FLAG) {
      // Two lengths - characters then bytes - each one or two bytes wide.
      for (let n = 0; n < 2; n++) p += chunk[p] & 0x80 ? 2 : 1
      out.push(chunk.toString('utf8', p, chunk.indexOf(0, p)))
    } else {
      let length = chunk.readUInt16LE(p)
      p += 2
      if (length & 0x8000) {
        length = ((length & 0x7fff) << 16) | chunk.readUInt16LE(p)
        p += 2
      }
      out.push(chunk.toString('utf16le', p, p + length * 2))
    }
  }
  return out
}

/** versionCode / versionName off the <manifest> tag of a compiled manifest. */
function manifestVersions(axml) {
  let pool = []
  for (let p = 8; p + 8 <= axml.length; ) {
    const kind = axml.readUInt16LE(p)
    const headerSize = axml.readUInt16LE(p + 2)
    const size = axml.readUInt32LE(p + 4)
    const chunk = axml.subarray(p, p + size)
    if (kind === RES_STRING_POOL) {
      pool = stringPool(chunk)
    } else if (kind === RES_XML_START_ELEMENT && pool[chunk.readUInt32LE(headerSize + 4)] === 'manifest') {
      const attributeStart = chunk.readUInt16LE(headerSize + 8)
      const attributeSize = chunk.readUInt16LE(headerSize + 10)
      const attributeCount = chunk.readUInt16LE(headerSize + 12)
      const got = {}
      for (let i = 0; i < attributeCount; i++) {
        const a = headerSize + attributeStart + i * attributeSize
        const name = pool[chunk.readUInt32LE(a + 4)]
        const rawValue = chunk.readUInt32LE(a + 8)
        if (name === 'versionCode') got.versionCode = chunk.readInt32LE(a + 16)
        if (name === 'versionName') got.versionName = rawValue === 0xffffffff ? null : pool[rawValue]
      }
      return got
    }
    p += size
  }
  throw new Error('compiled manifest has no <manifest> start tag')
}

// ----------------------------------------------------------------------- main

const digest = (algorithm, buf) => createHash(algorithm).update(buf).digest('hex')

async function identify(path) {
  const buf = await readFile(path)
  const index = entries(buf)
  const manifest = index.get('AndroidManifest.xml')
  if (!manifest) throw new Error('no AndroidManifest.xml - not an APK')

  const signers = []
  for (const { id, value } of idValuePairs(signingBlock(buf))) {
    const scheme = SCHEMES.get(id)
    if (!scheme) continue
    for (const certificate of signerCertificates(value)) {
      signers.push({
        scheme,
        certificateSha256: digest('sha256', certificate),
        certificateSha1: digest('sha1', certificate),
      })
    }
  }
  if (signers.length === 0) throw new Error('APK Signing Block carries no v2/v3 signature')

  // The bundled web app, so the version Settings shows can be tied to this file.
  const bundle = [...index.keys()].find((n) => /^assets\/public\/assets\/index-[^/]+\.js$/.test(n))

  return {
    file: path,
    fileSha256: digest('sha256', buf),
    ...manifestVersions(read(buf, manifest)),
    webBundle: bundle ?? null,
    webBundleSha256: bundle ? digest('sha256', read(buf, index.get(bundle))) : null,
    signers,
  }
}

const json = process.argv.includes('--json')
const paths = process.argv.slice(2).filter((a) => a !== '--json')
if (paths.length === 0) {
  console.error('usage: node scripts/apk-identity.mjs [--json] <apk>...')
  process.exit(2)
}

const results = []
let failed = false
for (const path of paths) {
  try {
    results.push(await identify(path))
  } catch (error) {
    failed = true
    if (json) results.push({ file: path, error: error.message })
    else console.error(`${path}\n  ERROR: ${error.message}`)
  }
}

if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const r of results) {
    if (r.error) continue
    console.log(r.file)
    console.log(`  versionName     ${r.versionName}`)
    console.log(`  versionCode     ${r.versionCode}`)
    console.log(`  apk sha256      ${r.fileSha256}`)
    if (r.webBundle) console.log(`  web bundle      ${r.webBundle.replace('assets/public/', '')}`)
    for (const s of r.signers) {
      console.log(`  ${s.scheme} signer cert  SHA-256 ${s.certificateSha256}`)
      console.log(`  ${' '.repeat(s.scheme.length)} signer cert  SHA-1   ${s.certificateSha1}`)
    }
  }
}

process.exit(failed ? 1 : 0)
