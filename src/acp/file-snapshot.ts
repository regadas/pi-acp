import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'

// Optional display work must never read an unbounded file or wait on a FIFO.
export const MAX_SNAPSHOT_BYTES = 1024 * 1024

/** null means absent; undefined means deliberately unavailable (not an empty/new file). */
export function fileSnapshot(path: string): string | null | undefined {
  let fd: number | undefined
  let found = false
  try {
    const before = statSync(path)
    found = true
    if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES) return undefined
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_SNAPSHOT_BYTES)
      return undefined
    const buffer = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    const current = statSync(path)
    if (
      length > MAX_SNAPSHOT_BYTES ||
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    )
      return undefined
    return buffer.subarray(0, length).toString('utf8')
  } catch (error) {
    return !found && (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
