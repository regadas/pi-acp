import { RequestError, type AuthMethod } from '@agentclientprotocol/sdk'

/**
 * Best-effort detection of missing credentials / not-configured errors from pi/providers.
 *
 * We can't do a full provider-specific check here, so we look for common substrings.
 * `authMethods` is the per-connection set the owning `PiAcpAgent` advertised at
 * initialize, so the error data never claims a method this client cannot use.
 */
export function maybeAuthRequiredError(err: unknown, authMethods: AuthMethod[] = []): RequestError | null {
  const msg = String((err as any)?.message ?? err ?? '')
  const s = msg.toLowerCase()

  // Explicit credential/configuration phrases only. Generic authorization
  // failures ("permission denied", "forbidden", bare "403") are routinely
  // produced by filesystem errors and provider rate/entitlement problems
  // that a login cannot fix, so they must stay internal errors.
  const patterns = [
    'api key',
    'apikey',
    'missing key',
    'no key',
    'not configured',
    'unauthorized',
    'unauthenticated',
    'not authenticated',
    'authentication',
    'credential',
    'log in',
    'login'
  ]

  // HTTP 401 (unauthenticated) with word boundaries so ids or token counts
  // containing "401" never classify as an auth problem.
  const http401 = /\b401\b/.test(s)

  const hit = http401 || patterns.some(p => s.includes(p))
  if (!hit) return null

  // Include the negotiated terminal auth method options in error data.
  return RequestError.authRequired(
    {
      authMethods
    },
    'Configure an API key or log in with an OAuth provider.'
  )
}
