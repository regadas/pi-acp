import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSnapshot, MAX_SNAPSHOT_BYTES } from '../../src/acp/file-snapshot.js'

test('fileSnapshot: bounded regular files, absence, symlinks and raced replacement', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-acp-snapshot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'file')
  assert.equal(fileSnapshot(path), null)
  assert.equal(fileSnapshot(root), undefined)
  fs.writeFileSync(path, 'before')
  assert.equal(fileSnapshot(path), 'before')
  if (process.platform !== 'win32') {
    fs.symlinkSync(path, join(root, 'link'))
    assert.equal(fileSnapshot(join(root, 'link')), 'before')
  }
  fs.truncateSync(path, MAX_SNAPSHOT_BYTES + 1)
  assert.equal(fileSnapshot(path), undefined)
  fs.writeFileSync(path, 'before')
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    fs.renameSync(path, path + '.old')
    fs.writeFileSync(path, 'replacement')
    return open(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  assert.equal(fileSnapshot(path), undefined, 'a different inode cannot become the pre-mutation snapshot')
})
