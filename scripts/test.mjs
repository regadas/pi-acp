import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { withIsolation, isolatedEnv } from './isolated-env.mjs'

export function discoverTests(directory = 'test') {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? discoverTests(path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
    })
    .sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = discoverTests()
  if (!files.length) throw new Error('No TypeScript tests discovered')
  // Disposable user state: tests must never touch the developer's real home,
  // adapter state, pi agent dir or sessions.
  const status = await withIsolation('pi-acp-test-env-', async dirs => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], {
      stdio: 'inherit',
      env: isolatedEnv(process.env, dirs)
    })
    if (result.error) throw result.error
    return result.status ?? 1
  })
  process.exit(status)
}
