// /api/people — the People screen. SUPER ADMIN ONLY, checked here on the
// server for every request; hiding the tile is not the protection.
//
//   GET                                  → { people: [{ email, name, role, lastSignIn, fixed }] }
//   POST   { email, name, role }         → add someone, or give an existing login access
//   PATCH  { email, role }               → change an admin/assistant's role
//   PATCH  { email, resetPassword: true } → set a new temporary password
//   DELETE { email }                     → remove launcher access (the login itself stays)
//
// Roles that can be given here: "admin" and "va". The super admin comes only
// from LAUNCHER_SUPERADMIN_EMAILS and can't be added, changed or removed here.
//
// A brand-new person gets a Quote Builder login with a temporary password,
// returned once in the response for the super admin to pass on privately.
// Their Quote Builder role follows: an admin is made a Quote Builder admin;
// an assistant keeps the Quote Builder's default (offload_va).

import { ASSIGNABLE_ROLES, ROLE_LABEL, isSuperadminEmail, parseList, normEmail, roleFor } from './_apps.js'
import { authenticate, bodyOf } from './_auth.js'
import {
  AdminError, listUsers, findUserByEmail, createUser, updateUser, getProfile, setProfileRole, temporaryPassword,
} from './_admin.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORDER = { superadmin: 0, admin: 1, va: 2 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function asPerson(u, env) {
  const role = roleFor({ email: u.email, appMetadata: u.app_metadata || {} }, env)
  return role && {
    email: normEmail(u.email),
    name: (u.user_metadata && u.user_metadata.full_name) || null,
    role,
    lastSignIn: u.last_sign_in_at || null,
    fixed: role === 'superadmin',
  }
}

export default async function handler(req, res, deps = {}) {
  const env = deps.env || process.env
  const fetchFn = deps.fetchFn || fetch
  const wait = deps.sleep || sleep

  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const who = await authenticate(req, res, { env, fetchFn })
  if (!who) return
  if (who.role !== 'superadmin') return res.status(403).json({ error: 'Only the super admin can manage people.' })
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'People needs SUPABASE_SERVICE_ROLE_KEY (the Quote Builder live project) in the launcher’s Vercel settings.' })
  }

  try {
    if (req.method === 'GET') {
      const users = await listUsers(env, fetchFn)
      const people = users.map(u => asPerson(u, env)).filter(Boolean)
      // A super admin listed in settings who has no login yet still shows.
      for (const e of parseList(env.LAUNCHER_SUPERADMIN_EMAILS)) {
        if (!people.some(p => p.email === e)) people.push({ email: e, name: null, role: 'superadmin', lastSignIn: null, fixed: true })
      }
      people.sort((a, b) => ORDER[a.role] - ORDER[b.role] || a.email.localeCompare(b.email))
      return res.status(200).json({ people })
    }

    const body = bodyOf(req)
    const email = normEmail(body.email)
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (isSuperadminEmail(email, env)) {
      return res.status(400).json({ error: 'The super admin is set in the launcher’s Vercel settings and can’t be changed here.' })
    }

    if (req.method === 'POST') {
      const role = body.role
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
      if (!ASSIGNABLE_ROLES.includes(role)) return res.status(400).json({ error: 'Choose Admin or Assistant.' })

      const existing = await findUserByEmail(env, email, fetchFn)
      if (existing) {
        const current = (existing.app_metadata || {}).launcher_role
        if (current === role) return res.status(200).json({ status: 'unchanged', email, role })
        await updateUser(env, existing.id, { app_metadata: { launcher_role: role } }, fetchFn)
        return res.status(200).json({ status: current ? 'role-changed' : 'granted', email, role })
      }

      const tempPassword = temporaryPassword()
      const created = await createUser(env, { email, password: tempPassword, name, role }, fetchFn)
      const id = created && (created.id || (created.user && created.user.id))

      // The Quote Builder's own sign-up trigger makes the profile; give it a
      // moment, then line its Quote Builder role up with the launcher role.
      let profile = null
      for (let i = 0; i < 6 && id && !profile; i++) {
        profile = await getProfile(env, id, fetchFn)
        if (!profile) await wait(300)
      }
      let note = null
      if (!profile) note = 'The login was created, but the Quote Builder did not make a profile for it. They can sign in to the launcher; the Quote Builder itself may not open for them.'
      else if (role === 'admin' && profile.role !== 'admin') await setProfileRole(env, id, 'admin', fetchFn)

      return res.status(201).json({ status: 'created', email, role, tempPassword, note })
    }

    const existing = await findUserByEmail(env, email, fetchFn)
    const current = existing && (existing.app_metadata || {}).launcher_role
    if (!existing || !ASSIGNABLE_ROLES.includes(current)) return res.status(404).json({ error: `${email} doesn’t have launcher access.` })

    if (req.method === 'PATCH') {
      if (body.resetPassword === true) {
        const tempPassword = temporaryPassword()
        await updateUser(env, existing.id, { password: tempPassword }, fetchFn)
        return res.status(200).json({ status: 'password-reset', email, tempPassword })
      }
      if (!ASSIGNABLE_ROLES.includes(body.role)) return res.status(400).json({ error: 'Choose Admin or Assistant.' })
      if (body.role === current) return res.status(200).json({ status: 'unchanged', email, role: current })
      await updateUser(env, existing.id, { app_metadata: { launcher_role: body.role } }, fetchFn)
      return res.status(200).json({ status: 'role-changed', email, role: body.role, label: ROLE_LABEL[body.role] })
    }

    // DELETE: take away launcher access. Their logins in each app stay, so
    // nothing they made is lost; the launcher simply stops letting them in.
    await updateUser(env, existing.id, { app_metadata: { launcher_role: null } }, fetchFn)
    return res.status(200).json({ status: 'removed', email })
  } catch (err) {
    if (err instanceof AdminError) return res.status(err.status === 422 ? 400 : (err.status || 502)).json({ error: err.message })
    throw err
  }
}
