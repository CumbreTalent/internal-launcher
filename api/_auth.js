// Session verification against Supabase Auth, without the Supabase SDK.
//
// The browser signs in directly with Supabase (see /auth.js) and sends the
// resulting access token here. Supabase's own /auth/v1/user endpoint is the
// source of truth for whether that token is valid, so the launcher needs only
// the public anon key and no privileged secret at all.

export class AuthUnavailable extends Error {}

// Resolves to { id, email } for a valid token, null for an invalid or expired
// one, and throws AuthUnavailable when Supabase could not be reached.
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
  return { id: user.id, email: String(user.email) }
}

export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim())
  return match ? match[1].trim() : ''
}
