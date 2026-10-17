// The People screen's server route: super admin only, and what each action does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import people from '../api/people.js'
import { temporaryPassword } from '../api/_admin.js'
import { fakeRes } from './_helpers.mjs'

const ENV = {
  SUPABASE_URL: 'https://qb.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  LAUNCHER_SUPERADMIN_EMAILS: 'omar@offloadcrew.com',
}

// In-memory Supabase for the Quote Builder live project.
function world() {
  const users = [
    { id: 'u-omar', email: 'omar@offloadcrew.com', app_metadata: {}, user_metadata: { full_name: 'Omar' }, last_sign_in_at: '2026-10-17T12:00:00Z' },
    { id: 'u-asad', email: 'asad@offloadcrew.com', app_metadata: { launcher_role: 'admin' }, user_metadata: {} },
    { id: 'u-va', email: 'va@example.com', app_metadata: { launcher_role: 'va' }, user_metadata: { full_name: 'Val' } },
    { id: 'u-cust', email: 'customer@contractor.com', app_metadata: {}, user_metadata: {} },
  ]
  const profiles = users.map(u => ({ id: u.id, role: 'offload_va' }))
  const calls = []
  let n = 0
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body == null ? '' : JSON.stringify(body)), json: async () => body })
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET'
    calls.push(`${method} ${u.pathname}`)
    if (u.pathname === '/auth/v1/user') {
      assert.equal(opts.headers.apikey, 'anon')
      const email = (/^Bearer tok:(.+)$/.exec(opts.headers.Authorization || '') || [])[1]
      const user = users.find(x => x.email === email)
      return user ? json(200, user) : json(401, { msg: 'invalid JWT' })
    }
    assert.equal(opts.headers.apikey, 'service', `${method} ${u.pathname} must use the service key`)
    if (u.pathname === '/auth/v1/admin/users' && method === 'GET') return json(200, { users: u.searchParams.get('page') === '1' ? users : [] })
    if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
      const b = JSON.parse(opts.body)
      if (users.some(x => x.email === b.email)) return json(422, { msg: 'already registered' })
      const user = { id: 'new-' + ++n, email: b.email, app_metadata: b.app_metadata, user_metadata: b.user_metadata, password: b.password, email_confirmed: b.email_confirm }
      users.push(user)
      profiles.push({ id: user.id, role: 'offload_va' }) // the Quote Builder's sign-up trigger
      return json(200, user)
    }
    const m = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(u.pathname)
    if (m && method === 'PUT') {
      const user = users.find(x => x.id === decodeURIComponent(m[1]))
      const b = JSON.parse(opts.body)
      if (b.app_metadata) for (const [k, v] of Object.entries(b.app_metadata)) { if (v === null) delete user.app_metadata[k]; else user.app_metadata[k] = v }
      if (b.password) user.password = b.password
      return json(200, user)
    }
    if (u.pathname === '/rest/v1/profiles') {
      const id = u.searchParams.get('id').replace(/^eq\./, '')
      const row = profiles.find(p => p.id === id)
      if (method === 'GET') return json(200, row ? [row] : [])
      if (method === 'PATCH') { Object.assign(row, JSON.parse(opts.body)); return json(204, null) }
    }
    throw new Error('unexpected ' + method + ' ' + url)
  }
  return { users, profiles, calls, fetchFn }
}

const run = async (w, token, method = 'GET', body, env = ENV) => {
  const res = fakeRes()
  await people({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res, { env, fetchFn: w.fetchFn, sleep: async () => {} })
  return res
}
const OMAR = 'tok:omar@offloadcrew.com'

test('only the super admin gets in: admin, assistant, outsider and anonymous are refused', async () => {
  const w = world()
  assert.equal((await run(w, 'tok:asad@offloadcrew.com')).statusCode, 403)
  assert.equal((await run(w, 'tok:va@example.com')).statusCode, 403)
  assert.equal((await run(w, 'tok:customer@contractor.com')).statusCode, 403)
  assert.equal((await run(w, null)).statusCode, 401)
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const res = await run(w, 'tok:asad@offloadcrew.com', method, { email: 'x@y.com', role: 'admin' })
    assert.equal(res.statusCode, 403, method)
  }
  assert.ok(!w.calls.some(c => c.startsWith('POST /auth/v1/admin') || c.startsWith('PUT /auth/v1/admin')), 'nothing was written')
})

test('GET lists only people with launcher access, super admin first', async () => {
  const res = await run(world(), OMAR)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.people.map(p => [p.email, p.role, p.fixed]), [
    ['omar@offloadcrew.com', 'superadmin', true],
    ['asad@offloadcrew.com', 'admin', false],
    ['va@example.com', 'va', false],
  ])
  assert.equal(res.body.people[0].lastSignIn, '2026-10-17T12:00:00Z')
})

test('add a brand-new admin: login created with a temporary password, Quote Builder admin role set', async () => {
  const w = world()
  const res = await run(w, OMAR, 'POST', { email: ' New.Admin@Offloadcrew.com ', name: 'New Admin', role: 'admin' })
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.status, 'created')
  assert.match(res.body.tempPassword, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/)
  const user = w.users.find(u => u.email === 'new.admin@offloadcrew.com')
  assert.equal(user.app_metadata.launcher_role, 'admin')
  assert.equal(user.password, res.body.tempPassword)
  assert.equal(user.email_confirmed, true)
  assert.equal(user.user_metadata.full_name, 'New Admin')
  assert.equal(w.profiles.find(p => p.id === user.id).role, 'admin')
})

test('add a brand-new assistant: Quote Builder keeps its default assistant role', async () => {
  const w = world()
  const res = await run(w, OMAR, 'POST', { email: 'new.va@example.com', role: 'va' })
  assert.equal(res.statusCode, 201)
  const user = w.users.find(u => u.email === 'new.va@example.com')
  assert.equal(w.profiles.find(p => p.id === user.id).role, 'offload_va')
  assert.ok(!w.calls.includes('PATCH /rest/v1/profiles'))
})

test('add someone who already has a Quote Builder login: access granted, no new password', async () => {
  const w = world()
  const res = await run(w, OMAR, 'POST', { email: 'customer@contractor.com', role: 'va' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'granted')
  assert.equal(res.body.tempPassword, undefined)
  assert.equal(w.users.find(u => u.email === 'customer@contractor.com').app_metadata.launcher_role, 'va')
  assert.equal((await run(w, OMAR, 'POST', { email: 'customer@contractor.com', role: 'va' })).body.status, 'unchanged')
})

test('change a role, reset a password, remove access', async () => {
  const w = world()
  let res = await run(w, OMAR, 'PATCH', { email: 'va@example.com', role: 'admin' })
  assert.equal(res.body.status, 'role-changed')
  assert.equal(w.users.find(u => u.email === 'va@example.com').app_metadata.launcher_role, 'admin')

  res = await run(w, OMAR, 'PATCH', { email: 'va@example.com', resetPassword: true })
  assert.equal(res.body.status, 'password-reset')
  assert.equal(w.users.find(u => u.email === 'va@example.com').password, res.body.tempPassword)

  res = await run(w, OMAR, 'DELETE', { email: 'va@example.com' })
  assert.equal(res.body.status, 'removed')
  assert.equal(w.users.find(u => u.email === 'va@example.com').app_metadata.launcher_role, undefined)
  assert.ok(!(await run(w, OMAR)).body.people.some(p => p.email === 'va@example.com'))
})

test('the super admin can never be added, changed or removed from the screen', async () => {
  const w = world()
  for (const [method, body] of [['POST', { email: 'omar@offloadcrew.com', role: 'va' }], ['PATCH', { email: 'OMAR@offloadcrew.com', role: 'va' }], ['DELETE', { email: 'omar@offloadcrew.com' }], ['PATCH', { email: 'omar@offloadcrew.com', resetPassword: true }]]) {
    const res = await run(w, OMAR, method, body)
    assert.equal(res.statusCode, 400, method)
  }
})

test('bad input is refused with a clear message', async () => {
  const w = world()
  assert.equal((await run(w, OMAR, 'POST', { email: 'not-an-email', role: 'va' })).statusCode, 400)
  assert.equal((await run(w, OMAR, 'POST', { email: 'a@b.co', role: 'superadmin' })).statusCode, 400)
  assert.equal((await run(w, OMAR, 'POST', { email: 'a@b.co', role: 'owner' })).statusCode, 400)
  assert.equal((await run(w, OMAR, 'PATCH', { email: 'customer@contractor.com', role: 'admin' })).statusCode, 404, 'no access to change')
  assert.equal((await run(w, OMAR, 'DELETE', { email: 'nobody@x.com' })).statusCode, 404)
  assert.equal((await run(w, OMAR, 'PUT', {})).statusCode, 405)
})

test('missing service key → clear setup error, before any admin call', async () => {
  const w = world()
  const { SUPABASE_SERVICE_ROLE_KEY, ...env } = ENV
  const res = await run(w, OMAR, 'GET', undefined, env)
  assert.equal(res.statusCode, 500)
  assert.match(res.body.error, /SUPABASE_SERVICE_ROLE_KEY/)
})

test('temporary passwords are varied and policy-friendly', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const p = temporaryPassword()
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /-/)
    assert.ok(!/[0O1lI]/.test(p), 'no look-alike characters')
    seen.add(p)
  }
  assert.equal(seen.size, 200)
})
