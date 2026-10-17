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

import { appFor, tileUrl, useCustomDomains, ticketRole } from './_apps.js'
import { authenticate, bodyOf } from './_auth.js'
import { signTicket } from './_ticket.js'

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env
  const fetchFn = deps.fetchFn || fetch
  const now = deps.now || Date.now()

  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const who = await authenticate(req, res, { env, fetchFn })
  if (!who) return

  const app = appFor(bodyOf(req).app, who.role)
  if (!app) return res.status(404).json({ error: 'No such app.' })

  const base = tileUrl(app, useCustomDomains(env))
  if (!app.sso || !env.LAUNCHER_SIGNING_KEY) return res.status(200).json({ url: base, sso: false })

  try {
    const ticket = signTicket(
      { aud: app.key, sub: who.user.email, role: ticketRole(who.role), name: who.user.name },
      env.LAUNCHER_SIGNING_KEY,
      { now },
    )
    const target = new URL('/api/launch', base)
    target.searchParams.set('ticket', ticket)
    return res.status(200).json({ url: target.toString(), sso: true })
  } catch (err) {
    // A broken key must not lock anyone out: open the app without SSO.
    console.error('[launch] could not sign ticket:', err && err.message)
    return res.status(200).json({ url: base, sso: false })
  }
}
