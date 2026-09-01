import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPiInvocation, resolveWindowsScriptCommand } from '../../src/pi-rpc/command.js'

test('buildPiInvocation launches native executables directly', () => {
  assert.deepEqual(buildPiInvocation('/opt/pi', ['--session', '/tmp/a b.jsonl'], { platform: 'linux' }), {
    executable: '/opt/pi',
    args: ['--session', '/tmp/a b.jsonl']
  })
})

test('buildPiInvocation resolves Windows batch launchers and escapes command syntax', () => {
  const invocation = buildPiInvocation('pi.cmd', ['--session', 'C:\\x y\\a"&|<>^()%!.jsonl'], {
    platform: 'win32',
    cwd: 'C:\\work',
    env: { PATH: 'C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    fileExists: path => path === 'C:\\bin\\pi.cmd'
  })
  assert.equal(invocation?.executable, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(invocation?.windowsVerbatimArguments, true)
  assert.deepEqual(invocation?.args.slice(0, 3), ['/d', '/s', '/c'])
  const commandLine = invocation?.args[3] ?? ''
  for (const escaped of ['^&', '^|', '^<', '^>', '^^', '^(', '^)', '%%', '^!']) assert.ok(commandLine.includes(escaped))
  assert.doesNotMatch(invocation?.args[3] ?? '', /shell:true/)
})

test('resolveWindowsScriptCommand does not accept a missing launcher', () => {
  assert.equal(
    resolveWindowsScriptCommand('pi.cmd', 'C:\\work', 'C:\\bin', () => false),
    null
  )
})
