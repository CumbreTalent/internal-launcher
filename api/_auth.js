// Session verification against Supabase Auth, without the Supabase SDK.
//
// The browser signs in directly with Supabase (see /auth.js) and sends the
// resulting access token here. Supabase's own /auth/v1/user endpoint is the
// source of truth for whether that token is valid, and it returns the
// person's current app_metadata, where their launcher role lives. Reading it
// fresh on every request means a role change or removal takes effect at once.

import { roleFor } from './_apps.js'

export class AuthUnavailable extends Error {}

// Resolves to { id, email, name, appMetadata } for a valid token, null for an
// invalid or expired one, and throws AuthUnavailable when Supabase could not
// be reached.
export async function verifyUser(token, { url, anon, fetchFn = fetch } = {}) {
  if (!token || !url || !anon) return null
  let res
  try {
    res = await fetchFn(`${url.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    throw new AuthUnavailable(err?.message || 'auth fetch failed')
  }
  if (res.status >= 500) throw new AuthUnavailable(`auth returned ${res.status}`)
  if (!res.ok) return null
  const user = await res.json().catch(() => null)
  if (!user || !user.id || !user.email) return null
  return {
    id: user.id,
    email: String(user.email),
    name: (user.user_metadata && typeof user.user_metadata.full_name === 'string') ? user.user_metadata.full_name : null,
    appMetadata: user.app_metadata || {},
  }
}

export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim())
  return match ? match[1].trim() : ''
}

export function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}

// The common front half of every launcher API route: configuration, token,
// Supabase check, role. Returns { user, role }, or sends the error itself and
// returns null so callers can just `if (!who) return`.
//   500 not configured · 401 no/invalid token · 403 no launcher role · 502 Supabase down
export async function authenticate(req, res, { env = process.env, fetchFn = fetch } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Launcher is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.' })
    return null
  }
  const token = bearerToken(req)
  if (!token) { res.status(401).json({ error: 'Sign in to continue.' }); return null }

  let user
  try {
    user = await verifyUser(token, { url: env.SUPABASE_URL, anon: env.SUPABASE_ANON_KEY, fetchFn })
  } catch (err) {
    if (err instanceof AuthUnavailable) {
      res.status(502).json({ error: 'Could not reach the sign-in service. Try again in a moment.' })
      return null
    }
    throw err
  }
  if (!user) { res.status(401).json({ error: 'Your session has expired. Sign in again.' }); return null }

  const role = roleFor(user, env)
  if (!role) {
    res.status(403).json({ error: 'This account is not allowed in the launcher. Ask the super admin to add it.' })
    return null
  }
  return { user, role, token }
}
