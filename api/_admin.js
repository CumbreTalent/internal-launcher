// Supabase admin calls for the People screen, against the Quote Builder's
// live project (the launcher's sign-in). Server-only: needs
// SUPABASE_SERVICE_ROLE_KEY, which can create logins, so it is only ever used
// behind the super-admin check in api/people.js.

import crypto from 'node:crypto'
import { normEmail } from './_apps.js'

export class AdminError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

function base(env) { return env.SUPABASE_URL.replace(/\/+$/, '') }
function headers(env) {
  const k = env.SUPABASE_SERVICE_ROLE_KEY
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }
}

async function call(env, fetchFn, method, path, body, extraHeaders = {}) {
  let r
  try {
    r = await fetchFn(`${base(env)}${path}`, { method, headers: { ...headers(env), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (err) {
    throw new AdminError('Could not reach Supabase. Try again in a moment.', 502)
  }
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!r.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || `Supabase returned ${r.status}`
    throw new AdminError(msg, r.status >= 500 ? 502 : r.status)
  }
  return data
}

// Every login in the project. The Quote Builder has a handful, so paging
// through is cheap; Supabase has no look-up-by-email admin call.
export async function listUsers(env, fetchFn = fetch) {
  const all = []
  for (let page = 1; page <= 50; page++) {
    const data = await call(env, fetchFn, 'GET', `/auth/v1/admin/users?page=${page}&per_page=200`)
    const users = Array.isArray(data) ? data : (data && data.users) || []
    all.push(...users)
    if (users.length < 200) break
  }
  return all
}

export async function findUserByEmail(env, email, fetchFn = fetch) {
  const e = normEmail(email)
  return (await listUsers(env, fetchFn)).find(u => normEmail(u.email) === e) || null
}

export async function createUser(env, { email, password, name, role }, fetchFn = fetch) {
  return call(env, fetchFn, 'POST', '/auth/v1/admin/users', {
    email: normEmail(email),
    password,
    email_confirm: true,
    user_metadata: name ? { full_name: name } : {},
    app_metadata: { launcher_role: role },
  })
}

// app_metadata updates merge key by key; a null value removes the key.
export async function updateUser(env, id, patch, fetchFn = fetch) {
  return call(env, fetchFn, 'PUT', `/auth/v1/admin/users/${encodeURIComponent(id)}`, patch)
}

export async function getProfile(env, id, fetchFn = fetch) {
  const rows = await call(env, fetchFn, 'GET', `/rest/v1/profiles?select=id,role&id=eq.${encodeURIComponent(id)}`)
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

export async function setProfileRole(env, id, role, fetchFn = fetch) {
  return call(env, fetchFn, 'PATCH', `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { role }, { Prefer: 'return=minimal' })
}

// Easy to read aloud or paste, hard to guess: four groups of four from an
// alphabet without look-alikes, always mixing lower, upper and digits, with
// hyphens so it also satisfies a "symbols required" password policy.
export function temporaryPassword() {
  const lower = 'abcdefghjkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit = '23456789'
  const all = lower + upper + digit
  const pick = set => set[crypto.randomInt(set.length)]
  for (;;) {
    const chars = Array.from({ length: 16 }, () => pick(all))
    const s = chars.join('')
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) return s.match(/.{4}/g).join('-')
  }
}
