import { RequestError } from '@agentclientprotocol/sdk'
import type { PiRpcTermination } from '../pi-rpc/process.js'

export function toRequestError(err: unknown): RequestError {
  if (err instanceof RequestError) return err
  const message = err instanceof Error ? err.message : String(err)
  return RequestError.internalError({}, message)
}

export function terminationError(termination: PiRpcTermination): Error {
  const base =
    termination.reason === 'error'
      ? `pi process failed: ${termination.error instanceof Error ? termination.error.message : String(termination.error)}`
      : `pi process exited unexpectedly (code=${termination.code}, signal=${termination.signal})`
  const tail = termination.stderrTail.trim()
  return new Error(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base)
}
