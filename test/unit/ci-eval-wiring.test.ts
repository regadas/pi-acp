import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const isWindows = process.platform === 'win32'

test('npm scripts expose the real-pi eval bridge and the manual stock-subagents probes', () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts as Record<string, string>
  for (const [script, file] of [
    ['eval:acp', 'scripts/eval-acp-client.mjs'],
    ['eval:subagents:completion', 'scripts/eval-subagents-completion.mjs'],
    ['eval:subagents:cancel', 'scripts/eval-subagents-cancel.mjs']
  ] as const) {
    assert.ok(typeof scripts[script] === 'string', `${script} must be a discoverable npm script`)
    assert.ok(scripts[script].includes(file), `${script} must run ${file}`)
    assert.ok(scripts[script].includes('npm run build'), `${script} must build the adapter first`)
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist`)
  }
})

test('CI and release gates run eval:acp after pi install and smoke, before public actions', () => {
  for (const workflow of [
    '.github/workflows/ci.yml',
    '.github/workflows/npm-publish.yml',
    '.github/workflows/github-release.yml'
  ]) {
    const text = readFileSync(join(repoRoot, workflow), 'utf8')
    const install = text.indexOf('npm install --global @earendil-works/pi-coding-agent@1.4.0')
    const smoke = text.indexOf('npm run smoke')
    const evalStep = text.indexOf('npm run eval:acp')
    assert.ok(install >= 0, `${workflow} must install pinned pi`)
    assert.ok(smoke > install, `${workflow} must smoke after installing pi`)
    assert.ok(evalStep > smoke, `${workflow} must run eval:acp after smoke`)
  }
  const publish = readFileSync(join(repoRoot, '.github/workflows/npm-publish.yml'), 'utf8')
  assert.ok(publish.indexOf('npm run eval:acp') < publish.indexOf('npm publish'), 'eval gate must precede publish')
  const release = readFileSync(join(repoRoot, '.github/workflows/github-release.yml'), 'utf8')
  assert.ok(
    release.indexOf('npm run eval:acp') < release.indexOf('action-gh-release'),
    'eval gate must precede the public release action'
  )
})

test('auxiliary probe docs pin the exact stock revision the eval scripts verify', () => {
  const doc = readFileSync(join(repoRoot, 'docs/adapter-reference.md'), 'utf8')
  assert.ok(doc.includes('PI_ACP_EVAL_SUBAGENTS'), 'docs must name the stock checkout variable')
  assert.ok(doc.includes('eval:subagents:completion'), 'docs must list the completion probe')
  assert.ok(doc.includes('eval:subagents:cancel'), 'docs must list the cancel probe')
  for (const probe of ['eval-subagents-completion', 'eval-subagents-cancel']) {
    const match = readFileSync(join(repoRoot, 'scripts', `${probe}.mjs`), 'utf8').match(
      /STOCK_REVISION = '([0-9a-f]{40})'/
    )
    assert.ok(match, `${probe} must pin a stock revision`)
    assert.ok(doc.includes(match[1]), `${probe}: docs must pin ${match[1]}`)
  }
})

test('stock-subagents probes refuse to run without the pinned checkout', () => {
  for (const probe of ['eval-subagents-completion.mjs', 'eval-subagents-cancel.mjs']) {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', probe)], {
      encoding: 'utf8',
      env: { ...process.env, PI_ACP_EVAL_SUBAGENTS: '' },
      timeout: 30_000
    })
    assert.notEqual(result.status, 0, `${probe} must refuse without PI_ACP_EVAL_SUBAGENTS`)
    assert.match(result.stderr, /PI_ACP_EVAL_SUBAGENTS/)
  }
})

test(
  'eval direct-launch classifier selfcheck passes against synthetic pi installs',
  { skip: isWindows ? 'POSIX-only: /usr/bin/env shebangs, symlinks and colon-delimited PATH' : false },
  () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'eval-acp-client.mjs'), '--selfcheck-direct'],
      {
        encoding: 'utf8',
        timeout: 60_000
      }
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /selfcheck-direct ok/)
  }
)

test('CI runs a Bun default-launch gate and the Windows wrapper tree-kill job', () => {
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  const job = (name: string, follow: string) => {
    const start = ci.indexOf(`  ${name}:`)
    const end = follow ? ci.indexOf(`  ${follow}:`) : ci.length
    assert.ok(start >= 0 && end > start, `ci.yml must define the ${name} job`)
    return ci.slice(start, end)
  }
  const bun = job('bun', 'windows')
  assert.ok(bun.includes('oven-sh/setup-bun'), 'the bun job must set up Bun explicitly')
  // An anchored run step, not a substring: the bun job's comments also mention
  // `npm test`, so a substring check could pass with the step removed.
  assert.match(bun, /^\s*- run: npm test$/m, 'the bun job must run the test suite with Bun on PATH')
  // dist/ is gitignored and nothing in npm test builds it: the bun job must
  // build before its smoke step or it fails deterministically on a fresh
  // checkout.
  const build = bun.indexOf('npm run build')
  assert.ok(build >= 0, 'the bun job must build dist before smoke')
  const install = bun.indexOf('npm install --global @earendil-works/pi-coding-agent@1.4.0')
  assert.ok(install >= 0, 'the bun job must install the pinned pi')
  assert.ok(bun.indexOf('npm run smoke') > install, 'the bun job must smoke after installing pi')
  assert.ok(bun.indexOf('npm run smoke') > build, 'the bun job must smoke after building dist')
  assert.ok(
    bun.includes('PI_ACP_EVAL_REQUIRE_DIRECT=1 npm run eval:acp'),
    'the bun job must require the default-launch eval variant'
  )
  const windows = job('windows', '')
  assert.ok(
    windows.includes(
      'node --import tsx --test --test-name-pattern "Windows \\.cmd wrapper" test/unit/pi-rpc-process.test.ts test/unit/pi-version.test.ts'
    ),
    'the windows job must run the targeted .cmd wrapper tree-kill and version-probe tests'
  )
})

test(
  'windows targeted job runs the exact tree-kill and version-probe selection',
  {
    // On Windows the targeted tests run for real (that is the job's purpose),
    // so the self-skip counts asserted here are POSIX-only.
    skip: isWindows ? 'Windows targeted CI runs the selected tests for real; counts differ there' : false
  },
  () => {
    // The parent test runner's NODE_TEST_CONTEXT would switch the spawned
    // `node --test` child to its IPC reporter, hiding the summary being asserted.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-name-pattern',
        'Windows \\.cmd wrapper',
        'test/unit/pi-rpc-process.test.ts',
        'test/unit/pi-version.test.ts'
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env }
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    // On POSIX both targeted tests self-skip; the anchored counts prove the
    // selection can never silently drop to zero (or drift past two).
    assert.match(result.stdout, /\btests 2\b/)
    assert.match(result.stdout, /\bskipped 2\b/)
  }
)
