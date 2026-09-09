import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('test runner: discovers root, current and deeply nested TypeScript tests without shell globbing', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-discovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'unit', 'nested'), { recursive: true })
  const paths = ['root.test.ts', 'unit/current.test.ts', 'unit/nested/deep.test.ts']
  for (const path of [...paths, 'unit/fixture.ts']) writeFileSync(join(root, path), '')
  const code = `import {discoverTests} from ${JSON.stringify(new URL('../../scripts/test.mjs', import.meta.url).href)}; console.log(JSON.stringify(discoverTests(${JSON.stringify(root)})))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), paths.map(path => join(root, path)).sort())
})
