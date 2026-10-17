// Wrapper-style pi RPC stand-in for the channel-unusable composition tests:
// it speaks the adapter's lifecycle bridge (pi-acp-control) so a real
// PiAcpSession prompt is staged, accepted and observed running, then exits
// its wrapper root on an explicit test command. `hold` mode keeps a grandchild
// alive inheriting the stdio pipes, so the root's close event never fires: a
// living descendant with closed or redirected pipes can still be writing the
// session file, so pipe EOF proves nothing about the tree.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const hold = process.argv[2] === 'hold'

let grandchildPid = 0
if (hold) {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  grandchildPid = holder.pid
}

const pidFile = process.env.PI_ACP_TEST_TREE_PID_FILE
if (pidFile) writeFileSync(pidFile, `${grandchildPid} ${process.pid}\n`)

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const controlAckStates = { begin: 'ready', withdraw: 'withdrawn', cancel: 'stopping', check: 'cancelled' }

function handle(cmd) {
  if (cmd.type === 'get_commands') {
    send({
      type: 'response',
      id: cmd.id,
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'pi-acp-control' }] }
    })
    return
  }
  if (cmd.type === 'prompt') {
    const control = /^\/pi-acp-control (begin|withdraw|cancel|check) (\S+)/.exec(cmd.message ?? '')
    if (control) {
      // The acknowledgement event must precede the correlated response so the
      // request settles only once its companion widget state is observed.
      send({
        type: 'extension_ui_request',
        id: `ack-${cmd.id}`,
        method: 'setWidget',
        widgetKey: 'pi-acp-lifecycle',
        widgetLines: [JSON.stringify({ version: 1, owner: control[2], state: controlAckStates[control[1]] })]
      })
      send({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: {} })
      return
    }
    // Acceptance, then a running agent turn that never settles on its own.
    send({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: {} })
    send({ type: 'agent_start' })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } })
    return
  }
  if (cmd.type === 'test-exit-wrapper') {
    send({ type: 'response', id: cmd.id, command: 'test-exit-wrapper', success: true, data: {} })
    process.exit(0)
  }
  send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    idx = buffer.indexOf('\n')
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch {
      /* Not a framed record. */
    }
  }
})
