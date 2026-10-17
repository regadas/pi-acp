// Windows integration fixture: the node grandchild behind a pi.cmd-style
// launcher (cmd.exe /d /s /c "<launcher>" ...). Answers the adapter's version
// preflight, reports its own pid and the wrapper's pid, then holds the
// inherited stdio pipes open until the process tree is terminated.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  const pidFile = process.env.PI_ACP_TEST_TREE_PID_FILE
  if (process.env.PI_ACP_TEST_HANG_VERSION === '1') {
    // Hanging-version mode for the probe-abort tests: hold the inherited
    // pipes so only a whole-tree kill can reach pipe EOF.
    if (pidFile) writeFileSync(pidFile, `${process.pid} ${process.ppid}\n`)
    setInterval(() => {}, 60_000)
  } else {
    process.stdout.write('1.3.0\n')
    process.exit(0)
  }
}

const pidFile = process.env.PI_ACP_TEST_TREE_PID_FILE
if (pidFile) writeFileSync(pidFile, `${process.pid} ${process.ppid}\n`)
process.stdout.write(`${JSON.stringify({ type: 'session_info_changed', ready: true })}\n`)
// Stay alive holding stdout so a root-only kill can never reach pipe EOF.
setInterval(() => {}, 60_000)
