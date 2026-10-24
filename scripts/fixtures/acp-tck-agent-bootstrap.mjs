// Owned TCK agent bootstrap: the runner launches every TCK agent through this
// script, which registers the agent root in the run's private registry BEFORE
// the adapter starts. Registration (not polling) is what makes separately
// sessioned agents discoverable even when uv exits before any sampling could
// observe them. The adapter runs in-process with stdio untouched, preserving
// the real ACP/Pi transport; the runner imports the same processIdentity for
// teardown revalidation. The registry is runner-created and runner-removed:
// a missing registry means the run is over, so a late start fails closed
// instead of recreating run state, and the shutdown seal below makes every
// bootstrap that races teardown refuse to import the adapter at all.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

// The teardown seal: once the runner writes this marker into the registry
// before its final teardown scan, registration is refused, because shutdown
// has begun and a late agent must not race cleanup.
export const SHUTDOWN_SEAL = 'runner-shutdown.seal'
export const isSealed = registryDir => existsSync(join(registryDir, SHUTDOWN_SEAL))

/**
 * OS process identity for pid-reuse safety: 'gone' (no such pid — safe to
 * retire), 'unknown' (cannot determine — never treated as safe), or a live
 * fingerprint that changes when the OS reuses the pid for another process.
 * /proc starttime on Linux, `ps lstart` elsewhere; absolute ps paths keep
 * hermetic PATHs working.
 */
export const processIdentity = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'gone' }
  if (existsSync('/proc')) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return { state: 'live', fingerprint: `proc:${fields[19] ?? ''}` }
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'gone' }
      return { state: 'unknown' }
    }
  }
  for (const command of ['/bin/ps', '/usr/bin/ps']) {
    const ps = spawnSync(command, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL'
    })
    if (ps.error) continue
    if (ps.status !== 0 || !ps.stdout.trim()) return { state: 'gone' }
    return { state: 'live', fingerprint: `lstart:${ps.stdout.trim()}` }
  }
  return { state: 'unknown' }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const agent = process.argv[2]
  const registryDir = process.env.PI_ACP_TCK_AGENT_REGISTRY
  if (!agent || !registryDir) {
    console.error('[acp-tck-bootstrap] expected <adapter path> and PI_ACP_TCK_AGENT_REGISTRY')
    process.exit(3)
  }
  if (!existsSync(registryDir)) {
    console.error(`[acp-tck-bootstrap] refusing to start: the run registry is missing (${registryDir})`)
    process.exit(3)
  }
  if (isSealed(registryDir)) {
    console.error('[acp-tck-bootstrap] refusing to start: the runner has begun shutdown')
    process.exit(3)
  }
  const identity = processIdentity(process.pid)
  if (identity.state !== 'live') {
    console.error(`[acp-tck-bootstrap] cannot determine own process identity: ${identity.state}`)
    process.exit(3)
  }
  const entry = join(registryDir, `${process.pid}.json`)
  writeFileSync(entry, JSON.stringify({ pid: process.pid, fingerprint: identity.fingerprint }))
  process.on('exit', () => {
    try {
      unlinkSync(entry)
    } catch {
      /* already removed or the process is dying anyway */
    }
  })
  // Fixture test seam: deterministically hold the write→post-check window open
  // so a test can simulate teardown removing the registration between them.
  const barrier = process.env.PI_ACP_TCK_TEST_POST_WRITE_BARRIER
  if (barrier) {
    const deadline = Date.now() + 10_000
    while (!existsSync(barrier) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  }
  // The post-registration check closes the write-vs-shutdown race: teardown
  // may have sealed — or already removed this entry along with the rest of
  // the run state — between the pre-check and the write above. The seal is
  // tested first, then the survival of the registration itself.
  if (isSealed(registryDir) || !existsSync(entry)) {
    console.error('[acp-tck-bootstrap] refusing to start: shutdown began during registration')
    process.exit(3)
  }
  // A file URL keeps checkout paths containing '#', '?' or '%' importable.
  await import(pathToFileURL(agent).href)
}
