// GET /api/apps — the tiles the signed-in person may open.
//
// Expects `Authorization: Bearer <supabase access token>`. Verifies the token
// with Supabase, works out the launcher role (super admin from
// LAUNCHER_SUPERADMIN_EMAILS, everyone else from their account), and returns
// only that role's tiles.
//
//   200 { email, name, role, apps: [{ key, label, url, icon, color, badge, embed }] }
//   401 no/invalid/expired token          → browser shows the sign-in form
//   403 valid account, no launcher role   → browser shows "not allowed"
//   502 Supabase unreachable              → browser shows a retry message

import { tilesFor } from './_apps.js'
import { authenticate } from './_auth.js'

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env
  const fetchFn = deps.fetchFn || fetch

  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const who = await authenticate(req, res, { env, fetchFn })
  if (!who) return

  return res.status(200).json({ email: who.user.email, name: who.user.name, role: who.role, apps: tilesFor(who.role, env) })
}
