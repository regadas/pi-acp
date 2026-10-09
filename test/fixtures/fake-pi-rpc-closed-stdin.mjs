import { closeSync } from 'node:fs'

closeSync(0)
process.stdout.write(JSON.stringify({ type: 'session_info_changed', ready: true }) + '\n')
setInterval(() => {}, 1_000)
