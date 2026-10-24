// Real Pi runtime with a deterministic local provider for the ACP TCK run;
// no network, no child agents. The runner's --cancel-prompt carries
// CANCEL_MARKER so the TCK cancellation tests find a turn still in flight.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

const CANCEL_MARKER = 'TCK_CANCEL_TURN'
const RESPONSE_TEXT = 'TCK_PROVIDER_RESPONSE'

export default function (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) {
  pi.registerProvider('acp-tck', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'isolated-no-network',
    api: 'acp-tck',
    models: [
      // Two models so the standard `model` config option has an alternative
      // value to switch to; reasoning so thought_level advertises levels; image
      // input matches the adapter's advertised promptCapabilities.image.
      {
        id: 'local',
        name: 'TCK local',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000
      },
      {
        id: 'alternate',
        name: 'TCK alternate',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000
      }
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream()
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: RESPONSE_TEXT }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop' as const,
        timestamp: Date.now()
      }
      const finish = () => {
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: RESPONSE_TEXT, partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end()
      }
      if (!JSON.stringify(context.messages).includes(CANCEL_MARKER)) {
        setTimeout(finish, 100)
        return stream
      }
      // Hold the turn open with slow deltas so session/cancel lands mid-flight;
      // bounded so a lost cancel ends the turn instead of hanging the suite.
      stream.push({ type: 'start', partial: message })
      let ticks = 0
      const timer = setInterval(() => {
        if (options?.signal?.aborted) {
          clearInterval(timer)
          stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } })
          stream.end()
          return
        }
        if (ticks++ >= 75) {
          clearInterval(timer)
          stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
          return
        }
        stream.push({ type: 'text_delta', contentIndex: 0, delta: `${RESPONSE_TEXT} `, partial: message })
      }, 200)
      return stream
    }
  })
}
