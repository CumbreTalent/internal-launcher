// GET /api/apps — the tiles the signed-in person may open.
//
// Expects `Authorization: Bearer <supabase access token>`. Verifies the token
// with Supabase, maps the email to a role via the LAUNCHER_ADMIN_EMAILS /
// LAUNCHER_VA_EMAILS allowlists, and returns only that role's tiles.
//
//   200 { email, role, apps: [{ label, url, icon, color, badge }] }
//   401 no/invalid/expired token          → browser shows the sign-in form
//   403 valid account, not on either list → browser shows "not allowed"
//   502 Supabase unreachable              → browser shows a retry message

import { roleFor, tilesFor } from './_apps.js'
import { verifyUser, bearerToken, AuthUnavailable } from './_auth.js'

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env
  const fetchFn = deps.fetchFn || fetch

  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
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
  if (!role) {
    return res.status(403).json({ error: 'This account is not allowed in the launcher. Ask an admin to add it.' })
  }

  return res.status(200).json({ email: user.email, role, apps: tilesFor(role, env) })
}
