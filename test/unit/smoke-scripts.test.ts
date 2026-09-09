import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

for (const mode of ['success', 'error', 'early-exit', 'timeout', 'malformed', 'spawn-error']) {
  test(`smoke-client: ${mode} cannot produce false success or wait indefinitely`, () => {
    const fake =
      mode === 'early-exit'
        ? 'process.exit(0)'
        : `
      process.stdin.setEncoding('utf8');
      process.stdin.on('end',()=>process.exit(0));
      process.stdin.on('data', chunk=> {
        if (${JSON.stringify(mode)} === 'timeout') return;
        const request=JSON.parse(chunk);
        process.stdout.write(${JSON.stringify(mode)} === 'malformed' ? 'not json\\n' : JSON.stringify({id:request.id,...(${JSON.stringify(mode)} === 'error' ? {error:{message:'broken'}} : {result:{ok:true}})})+'\\n');
      });`
    const code = `import {withSmokeAgent} from ${JSON.stringify(new URL('../../scripts/smoke-client.mjs', import.meta.url).href)};
      await withSmokeAgent(async client=> { await client.request('probe', {}); }, { command: ${mode === 'spawn-error' ? JSON.stringify('/nonexistent/pi-acp-smoke-command') : 'process.execPath'}, args:['-e',${JSON.stringify(fake)}], timeoutMs:500 });`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      timeout: 8_000,
      killSignal: 'SIGKILL'
    })
    assert.equal(result.error, undefined, String(result.error))
    if (mode === 'success') assert.equal(result.status, 0, result.stderr)
    else assert.notEqual(result.status, 0, mode)
  })
}

test('manual provider probes refuse execution without explicit opt-in', () => {
  for (const script of ['smoke-compact.mjs', 'smoke-export.mjs', 'smoke-acp-load.mjs']) {
    const result = spawnSync(process.execPath, [new URL('../../scripts/' + script, import.meta.url).pathname], {
      encoding: 'utf8',
      env: { ...process.env, PI_ACP_MANUAL_PROVIDER: '' },
      timeout: 3_000
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /PI_ACP_MANUAL_PROVIDER=1/)
  }
})
