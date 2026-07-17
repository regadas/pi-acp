// Child worker for multi-process SessionStore tests.
// Usage: node --import tsx session-store-child.ts <mapPath> <uniqueSessionId> <sharedSessionId> <cwdTag>
import { SessionStore } from '../../src/acp/session-store.js'

const [, , mapPath, uniqueSessionId, sharedSessionId, cwdTag] = process.argv
if (!mapPath || !uniqueSessionId || !sharedSessionId || !cwdTag) {
  console.error('missing argv')
  process.exit(2)
}

const store = new SessionStore(mapPath)
store.upsert({
  sessionId: uniqueSessionId,
  cwd: `/tmp/${cwdTag}`,
  sessionFile: `/tmp/${cwdTag}/${uniqueSessionId}.jsonl`
})
store.upsert({ sessionId: sharedSessionId, cwd: `/tmp/${cwdTag}`, sessionFile: `/tmp/${cwdTag}/shared.jsonl` })
process.exit(0)
