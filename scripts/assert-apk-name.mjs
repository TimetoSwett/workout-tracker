// Validate the actual publisher output with the same parser the app uses.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(fs.readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const exports = {}
new Function('exports', '__APP_VERSION__', '__APP_VERSION_CODE__', js)(exports, '', 0)
const [name, mode] = process.argv.slice(2)
assert.ok(['release', 'debug-signed'].includes(mode), 'Unknown signing mode')
const parsed = exports.parseApkName(name)
if (mode === 'release') {
  assert.deepEqual(parsed, {
    versionName: process.env.APP_VERSION_NAME,
    versionCode: Number(process.env.APP_VERSION_CODE),
  }, 'Published APK name must round-trip through the updater parser')
} else {
  assert.equal(parsed, null, 'Debug APK must never be offered by the updater')
}
console.log('PASS: publisher APK name / updater parser contract')
