#!/usr/bin/env node
// Runs the `test/*.check.ts` suites.
//
// The app has no test runner and does not need one yet: the logic worth checking here is
// pure, so it runs under plain Node. Node cannot load the sources directly — they use
// extensionless imports, which only a bundler resolves — so the repo's own TypeScript
// compiles them to a temporary CommonJS tree first, which resolves extensionless requires
// natively. The compile doubles as a typecheck of the suites, which `tsc -b` skips because
// tsconfig.app.json only includes `src`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const suites = readdirSync(join(root, 'test'))
  .filter((f) => f.endsWith('.check.ts'))
  .sort()

if (suites.length === 0) {
  console.error('no test/*.check.ts suites found')
  process.exit(1)
}

// Emit under the repo's own node_modules (alongside the tsbuildinfo the build already
// puts there) rather than /tmp: the store imports `preact/hooks`, which only resolves
// from inside the project tree.
const out = join(root, 'node_modules/.tmp/checks')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
try {
  execFileSync(
    join(root, 'node_modules/.bin/tsc'),
    [
      ...suites.map((f) => join('test', f)),
      // The repo tsconfig is `noEmit` and bundler-resolved; these suites need a CommonJS
      // emit instead, so every option they rely on is passed explicitly.
      '--ignoreConfig',
      '--outDir', out,
      '--rootDir', '.',
      '--module', 'commonjs',
      '--target', 'es2023',
      '--lib', 'es2023',
      '--types', 'node',
      '--strict',
      '--skipLibCheck',
    ],
    { cwd: root, stdio: 'inherit' },
  )
  // No `"type"` field, so Node reads the emitted `.js` as CommonJS regardless of the
  // repo's own `"type": "module"`.
  writeFileSync(join(out, 'package.json'), '{}\n')

  let failed = false
  for (const f of suites) {
    const js = join(out, 'test', f.replace(/\.ts$/, '.js'))
    console.log(`\n=== ${f} ===`)
    try {
      execFileSync(process.execPath, [js], { stdio: 'inherit' })
    } catch {
      failed = true
    }
  }
  if (failed) process.exit(1)
} finally {
  rmSync(out, { recursive: true, force: true })
}
