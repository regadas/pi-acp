import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

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
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], {
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
