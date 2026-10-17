import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

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
    const install = text.indexOf('npm install --global @earendil-works/pi-coding-agent@1.2.0')
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
