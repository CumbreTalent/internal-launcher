// POST /api/launch  { app: "<tile key>" } — the address to open for one app.
//
// For apps with the sign-in receiver, the address carries a 60-second launch
// ticket, so the app signs the person in without asking for a password.
// Until LAUNCHER_SIGNING_KEY is set, it returns the plain app address and the
// app asks for its own login, exactly as before.
//
//   200 { url, sso }         open this address
//   401 / 403 / 502          same meanings as /api/apps
//   404                      no such app for this role (unknown and forbidden look alike)

import { roleFor, appFor, tileUrl, useCustomDomains } from './_apps.js'
import { verifyUser, bearerToken, AuthUnavailable } from './_auth.js'
import { signTicket } from './_ticket.js'

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return {} } }
  return {}
}

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env
  const fetchFn = deps.fetchFn || fetch
  const now = deps.now || Date.now()

  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Launcher is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.' })
  }

  const token = bearerToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })

  let user
  try {
    user = await verifyUser(token, { url: env.SUPABASE_URL, anon: env.SUPABASE_ANON_KEY, fetchFn })
  } catch (err) {
    if (err instanceof AuthUnavailable) {
      return res.status(502).json({ error: 'Could not reach the sign-in service. Try again in a moment.' })
    }
    throw err
  }
  if (!user) return res.status(401).json({ error: 'Your session has expired. Sign in again.' })

  const role = roleFor(user.email, env)
  if (!role) return res.status(403).json({ error: 'This account is not allowed in the launcher.' })

  const app = appFor(bodyOf(req).app, role)
  if (!app) return res.status(404).json({ error: 'No such app.' })

  const base = tileUrl(app, useCustomDomains(env))
  if (!app.sso || !env.LAUNCHER_SIGNING_KEY) return res.status(200).json({ url: base, sso: false })

  try {
    const ticket = signTicket({ aud: app.key, sub: user.email, role }, env.LAUNCHER_SIGNING_KEY, { now })
    const target = new URL('/api/launch', base)
    target.searchParams.set('ticket', ticket)
    return res.status(200).json({ url: target.toString(), sso: true })
  } catch (err) {
    // A broken key must not lock anyone out: open the app without SSO.
    console.error('[launch] could not sign ticket:', err && err.message)
    return res.status(200).json({ url: base, sso: false })
  }
}
