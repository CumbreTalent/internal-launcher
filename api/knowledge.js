// GET /api/knowledge — the admin-only part of the Knowledge page.
//
// knowledge.html is a static file built without the `sales` block (discovery
// questions, offer status, the objection pivot). Admins and the super admin get
// that block from here; the page asks only after /api/apps reports such a
// role, and an assistant's browser never receives it, from the file or from
// this route. Authenticated like /api/apps.
//
//   200 { sales }                          admin or super admin
//   403                                    assistant, or an account with no launcher role
//   401 / 405 / 500 / 502                  same meanings as /api/apps

import { isAdminLevel } from './_apps.js'
import { authenticate } from './_auth.js'
import { SALES } from './_knowledge-sales.js'

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
  if (!isAdminLevel(who.role)) return res.status(403).json({ error: 'Sales plays are for admins.' })

  return res.status(200).json({ sales: SALES })
}
