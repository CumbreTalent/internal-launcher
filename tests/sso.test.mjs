// Single sign-on: the launcher's ticket route and the shared app receiver.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { signTicket, generateKeyPair, publicKeyFor, TICKET_TTL_S } from '../api/_ticket.js'
import launch from '../api/launch.js'
import {
  verifyTicket, audienceFor, receive, supabaseLaunch, sendSessionRedirect,
  findProfileByEmail, callRpc, mintSession, provisionAccount,
} from '../receiver/_launcher.js'
import { fakeFetch, fakeRes } from './_helpers.mjs'

const KEYS = generateKeyPair()
const OTHER = generateKeyPair()
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

const LAUNCHER_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  LAUNCHER_SUPERADMIN_EMAILS: 'owner@offloadcrew.com',
  LAUNCHER_SIGNING_KEY: KEYS.signingKey,
}

const ticket = (claims = {}, { key = KEYS.signingKey, now = NOW, ttl } = {}) =>
  signTicket({ aud: 'quotes', sub: 'VA@Example.com', role: 'va', ...claims }, key, { now, ttl })

// ── Tickets ──

test('key pair: public key derives from the signing key', () => {
  assert.equal(publicKeyFor(KEYS.signingKey), KEYS.publicKey)
  assert.match(KEYS.signingKey, /^[A-Za-z0-9+/=]+$/)
  assert.ok(KEYS.signingKey.length < 100 && KEYS.publicKey.length < 100, 'keys stay paste-friendly')
})

test('ticket round trip: claims survive, email is normalised, lifetime is 60s', () => {
  const r = verifyTicket(ticket(), { publicKey: KEYS.publicKey, audience: 'quotes', now: NOW + 5_000 })
  assert.equal(r.ok, true)
  assert.equal(r.claims.sub, 'va@example.com')
  assert.equal(r.claims.role, 'va')
  assert.equal(r.claims.aud, 'quotes')
  assert.equal(r.claims.exp - r.claims.iat, TICKET_TTL_S)
  assert.match(r.claims.jti, /^[0-9a-f-]{36}$/)
})

test('ticket rejected: wrong app, expired, future, other key, tampered, junk', () => {
  const pk = { publicKey: KEYS.publicKey }
  assert.equal(verifyTicket(ticket(), { ...pk, audience: 'console', now: NOW }).reason, 'wrong-app')
  assert.equal(verifyTicket(ticket(), { ...pk, audience: ['invoices', 'training'], now: NOW }).reason, 'wrong-app')
  assert.equal(verifyTicket(ticket(), { ...pk, audience: 'quotes', now: NOW + 120_000 }).reason, 'expired')
  assert.equal(verifyTicket(ticket({}, { now: NOW + 600_000 }), { ...pk, audience: 'quotes', now: NOW }).reason, 'not-yet-valid')
  assert.equal(verifyTicket(ticket({}, { key: OTHER.signingKey }), { ...pk, audience: 'quotes', now: NOW }).reason, 'bad-signature')
  assert.equal(verifyTicket(ticket({}, { ttl: 3600 }), { ...pk, audience: 'quotes', now: NOW }).reason, 'malformed')

  // Swap in a payload claiming admin, keep the VA's signature.
  const [v, , sig] = ticket().split('.')
  const forged = Buffer.from(JSON.stringify({ iss: 'offload-crew-launcher', aud: 'quotes', sub: 'va@example.com', role: 'admin', iat: NOW / 1000, exp: NOW / 1000 + 60 })).toString('base64url')
  assert.equal(verifyTicket(`${v}.${forged}.${sig}`, { ...pk, audience: 'quotes', now: NOW }).reason, 'bad-signature')

  for (const junk of ['', 'abc', 'v1.a', 'v2.a.b', 'v1.a.b.c', null, undefined]) {
    assert.equal(verifyTicket(junk, { ...pk, audience: 'quotes', now: NOW }).ok, false, String(junk))
  }
  assert.equal(verifyTicket(ticket(), { publicKey: 'not-a-key', audience: 'quotes', now: NOW }).reason, 'not-configured')
  assert.equal(verifyTicket(ticket(), { publicKey: '', audience: 'quotes', now: NOW }).reason, 'not-configured')
  // An RSA public key is refused even if it parses.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  assert.equal(verifyTicket(ticket(), { publicKey: rsa, audience: 'quotes', now: NOW }).reason, 'not-configured')
})

test('audienceFor: production vs staging vs override', () => {
  const a = { production: 'quotes', other: 'quotes-staging' }
  assert.equal(audienceFor(a, { VERCEL_ENV: 'production' }), 'quotes')
  assert.equal(audienceFor(a, { VERCEL_ENV: 'preview' }), 'quotes-staging')
  assert.equal(audienceFor(a, {}), 'quotes-staging')
  assert.equal(audienceFor({ production: 'invoices' }, { VERCEL_ENV: 'preview' }), 'invoices')
  assert.equal(audienceFor(a, { VERCEL_ENV: 'production', LAUNCHER_APP_KEY: 'x' }), 'x')
})

// ── Launcher route: POST /api/launch ──

const lreq = (token, body, method = 'POST') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body })
const callLaunch = (r, env = LAUNCHER_ENV) => { const res = fakeRes(); return launch(r, res, { env, fetchFn: fakeFetch, now: NOW }).then(() => res) }

test('launch: VA gets a signed address for an app they may open', async () => {
  const res = await callLaunch(lreq('tok:va@example.com', { app: 'quotes' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.sso, true)
  const u = new URL(res.body.url)
  assert.equal(u.origin + u.pathname, 'https://offload-quote-builder.vercel.app/api/launch')
  const v = verifyTicket(u.searchParams.get('ticket'), { publicKey: KEYS.publicKey, audience: 'quotes', now: NOW })
  assert.equal(v.ok, true)
  assert.equal(v.claims.role, 'va')
  assert.equal(v.claims.sub, 'va@example.com')
})

test('launch: string bodies are parsed; custom domains are used when switched on', async () => {
  const res = await callLaunch(lreq('tok:owner@offloadcrew.com', JSON.stringify({ app: 'console-staging' })), { ...LAUNCHER_ENV, LAUNCHER_USE_CUSTOM_DOMAINS: '1' })
  assert.equal(res.statusCode, 200)
  const u = new URL(res.body.url)
  assert.equal(u.origin, 'https://console-staging.offloadcrew.com')
  assert.equal(verifyTicket(u.searchParams.get('ticket'), { publicKey: KEYS.publicKey, audience: 'console-staging', now: NOW }).claims.role, 'admin')
})

test('launch: a tile on the custom-domain list gets its ticket there; others stay on vercel.app', async () => {
  const env = { ...LAUNCHER_ENV, LAUNCHER_USE_CUSTOM_DOMAINS: 'crm' }
  const crm = new URL((await callLaunch(lreq('tok:owner@offloadcrew.com', { app: 'crm' }), env)).body.url)
  assert.equal(crm.origin + crm.pathname, 'https://crm.offloadcrew.com/api/launch')
  assert.equal(verifyTicket(crm.searchParams.get('ticket'), { publicKey: KEYS.publicKey, audience: 'crm', now: NOW }).ok, true)
  const quotes = new URL((await callLaunch(lreq('tok:owner@offloadcrew.com', { app: 'quotes' }), env)).body.url)
  assert.equal(quotes.origin, 'https://offload-quote-builder.vercel.app')
})

test('launch: the super admin opens apps as an admin, and tickets carry the name', async () => {
  const res = await callLaunch(lreq('tok:owner@offloadcrew.com', { app: 'invoices' }))
  const claims = verifyTicket(new URL(res.body.url).searchParams.get('ticket'), { publicKey: KEYS.publicKey, audience: 'invoices', now: NOW }).claims
  assert.equal(claims.role, 'admin')
  assert.equal(claims.name, 'Name owner@offloadcrew.com')
})

test('launch: People is a launcher page for the super admin only', async () => {
  assert.deepEqual((await callLaunch(lreq('tok:owner@offloadcrew.com', { app: 'people' }))).body, { url: '/people.html', sso: false })
  assert.equal((await callLaunch(lreq('tok:admin2@example.com', { app: 'people' }))).statusCode, 404)
  assert.equal((await callLaunch(lreq('tok:va@example.com', { app: 'people' }))).statusCode, 404)
})

test('launch: a hidden app cannot be launched, even by an admin', async () => {
  const res = await callLaunch(lreq('tok:owner@offloadcrew.com', { app: 'console' }))
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.url, undefined)
})

test('launch: VA asking for an admin app gets the same 404 as an unknown app', async () => {
  for (const app of ['console', 'quotes-staging', 'console-staging', 'nope', undefined]) {
    const res = await callLaunch(lreq('tok:va@example.com', { app }))
    assert.equal(res.statusCode, 404, String(app))
    assert.equal(res.body.url, undefined)
  }
})

test('launch: Workflows needs no ticket', async () => {
  const res = await callLaunch(lreq('tok:va@example.com', { app: 'workflows' }))
  assert.deepEqual(res.body, { url: '/workflow.html', sso: false })
})

test('launch: without a signing key, or with a broken one, apps open without SSO', async () => {
  const { LAUNCHER_SIGNING_KEY, ...noKey } = LAUNCHER_ENV
  let res = await callLaunch(lreq('tok:va@example.com', { app: 'invoices' }), noKey)
  assert.deepEqual(res.body, { url: 'https://invoice-chaser-silk.vercel.app', sso: false })
  const logged = console.error; console.error = () => {}
  try { res = await callLaunch(lreq('tok:va@example.com', { app: 'invoices' }), { ...LAUNCHER_ENV, LAUNCHER_SIGNING_KEY: 'broken' }) }
  finally { console.error = logged }
  assert.deepEqual(res.body, { url: 'https://invoice-chaser-silk.vercel.app', sso: false })
})

test('launch: auth failures mirror /api/apps', async () => {
  assert.equal((await callLaunch(lreq(null, { app: 'quotes' }))).statusCode, 401)
  assert.equal((await callLaunch(lreq('bad', { app: 'quotes' }))).statusCode, 401)
  assert.equal((await callLaunch(lreq('tok:customer@x.com', { app: 'quotes' }))).statusCode, 403)
  assert.equal((await callLaunch(lreq('tok:va@example.com', { app: 'quotes' }, 'GET'))).statusCode, 405)
  const res = fakeRes()
  await launch(lreq('tok:va@example.com', { app: 'quotes' }), res, { env: LAUNCHER_ENV, fetchFn: async () => { throw new Error('down') }, now: NOW })
  assert.equal(res.statusCode, 502)
})

// ── Receiver: what every app runs ──

const APP_ENV = { LAUNCHER_PUBLIC_KEY: KEYS.publicKey, LAUNCHER_URL: 'https://apps.offloadcrew.com' }
const rreq = (t, method = 'GET') => ({ method, url: t === undefined ? '/api/launch' : `/api/launch?ticket=${encodeURIComponent(t)}`, headers: {} })

test('receive: valid ticket returns claims; failures render a page, never claims', () => {
  let res = fakeRes()
  assert.equal(receive(rreq(ticket()), res, { appName: 'Quote Builder', audience: 'quotes', env: APP_ENV, now: NOW }).sub, 'va@example.com')

  const cases = [
    [rreq(undefined), 400, /Open this app from the Offload Crew Launcher/],
    [rreq('junk'), 401, /not valid/],
    [rreq(ticket()), 401, /expired/, NOW + 600_000],
    [rreq(ticket({ aud: 'console' })), 401, /different app/],
    [rreq(ticket(), 'POST'), 405, /Not allowed/],
  ]
  for (const [r, status, text, now = NOW] of cases) {
    res = fakeRes()
    assert.equal(receive(r, res, { appName: 'Quote Builder', audience: 'quotes', env: APP_ENV, now }), null)
    assert.equal(res.statusCode, status)
    assert.match(res.text, text)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer')
    assert.match(res.text, /apps\.offloadcrew\.com/)
  }

  res = fakeRes()
  assert.equal(receive(rreq(ticket()), res, { appName: 'Quote Builder', audience: 'quotes', env: {}, now: NOW }), null)
  assert.equal(res.statusCode, 503)
  assert.match(res.text, /not set up yet/)
  assert.match(res.text, /href="\/"/, 'offers the normal sign-in')
})

test('receive: page text is escaped', () => {
  const res = fakeRes()
  receive(rreq(undefined), res, { appName: '<script>x</script>', audience: 'quotes', env: APP_ENV, now: NOW })
  assert.ok(!res.text.includes('<script>x'))
  assert.ok(res.text.includes('&lt;script&gt;'))
})

test('sendSessionRedirect: tokens go in the fragment, never the query', () => {
  const res = fakeRes()
  sendSessionRedirect(res, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, expires_at: 99, token_type: 'bearer' })
  assert.equal(res.statusCode, 302)
  const loc = res.headers.Location
  assert.ok(loc.startsWith('/#'))
  const f = new URLSearchParams(loc.slice(2))
  assert.equal(f.get('access_token'), 'AT')
  assert.equal(f.get('refresh_token'), 'RT')
  assert.equal(f.get('type'), 'magiclink')
  assert.equal(f.get('token_type'), 'bearer')
  assert.equal(f.get('expires_in'), '3600')
})

// A tiny in-memory Supabase: profiles, an RPC, generate_link and verify.
function fakeSupabase({ profiles = [], rpc = {}, users = {}, failVerifyType = null, defaultRole = 'member', trigger = true, createStatus = 200 } = {}) {
  const calls = []
  const issued = new Map()
  let nextId = 1
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
  const fn = async (url, opts = {}) => {
    const u = new URL(url)
    calls.push(`${opts.method || 'GET'} ${u.pathname}`)
    assert.equal(opts.headers.apikey, 'service-key')
    assert.equal(opts.headers.Authorization, 'Bearer service-key')
    if (u.pathname === '/rest/v1/profiles' && (opts.method || 'GET') === 'GET') {
      const email = u.searchParams.get('email').replace(/^eq\./, '')
      return json(200, profiles.filter(p => p.email === email))
    }
    if (u.pathname === '/rest/v1/profiles' && opts.method === 'PATCH') {
      const id = u.searchParams.get('id').replace(/^eq\./, '')
      const row = profiles.find(p => p.id === id)
      Object.assign(row, JSON.parse(opts.body))
      return json(204, null)
    }
    if (u.pathname === '/auth/v1/admin/users' && opts.method === 'POST') {
      if (createStatus !== 200) return json(createStatus, { msg: 'A user with this email address has already been registered' })
      const body = JSON.parse(opts.body)
      assert.equal(body.email_confirm, true)
      assert.equal(body.password, undefined, 'automatic accounts get no password')
      const id = 'new-' + nextId++
      users[body.email] = { id }
      if (trigger) profiles.push({ id, email: body.email, role: defaultRole, full_name: body.user_metadata.full_name })
      return json(200, { id, email: body.email })
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const name = u.pathname.split('/').pop()
      if (!(name in rpc)) return json(404, { code: 'PGRST202', message: 'not found' })
      return json(200, rpc[name](JSON.parse(opts.body)))
    }
    if (u.pathname === '/auth/v1/admin/generate_link') {
      const { email, type } = JSON.parse(opts.body)
      assert.equal(type, 'magiclink')
      const user = users[email]
      const hashed = 'h-' + email
      issued.set(hashed, email)
      return json(200, user
        ? { id: user.id, email, hashed_token: hashed, verification_type: 'magiclink' }
        : { id: 'new-user', email, hashed_token: hashed, verification_type: 'signup' })
    }
    if (u.pathname === '/auth/v1/verify') {
      const { type, token_hash } = JSON.parse(opts.body)
      if (type === failVerifyType) return json(400, { msg: 'Email link is invalid or has expired' })
      const email = issued.get(token_hash)
      if (!email) return json(400, { msg: 'invalid' })
      issued.delete(token_hash)
      return json(200, { access_token: 'AT-' + email, refresh_token: 'RT-' + email, expires_in: 3600, expires_at: 123, token_type: 'bearer', user: { email } })
    }
    throw new Error('unexpected ' + url)
  }
  fn.calls = calls
  return fn
}

const SB = {
  profiles: [{ id: 'u-va', email: 'va@example.com', access_status: 'active' }, { id: 'u-owner', email: 'owner@offloadcrew.com' }],
  users: { 'va@example.com': { id: 'u-va' }, 'owner@offloadcrew.com': { id: 'u-owner' } },
}
const launchApp = (t, sb, opts = {}) => {
  const res = fakeRes()
  return supabaseLaunch(rreq(t), res, {
    appName: 'Invoice Chaser', audience: 'quotes', supabaseUrl: 'https://app.supabase.co', serviceKey: 'service-key',
    env: APP_ENV, now: NOW, fetchFn: sb, ...opts,
  }).then(() => res)
}

test('supabaseLaunch: known person is signed in with a fresh session', async () => {
  const sb = fakeSupabase(SB)
  const res = await launchApp(ticket(), sb)
  assert.equal(res.statusCode, 302)
  const f = new URLSearchParams(res.headers.Location.split('#')[1])
  assert.equal(f.get('access_token'), 'AT-va@example.com')
  assert.deepEqual(sb.calls, ['GET /rest/v1/profiles', 'POST /auth/v1/admin/generate_link', 'POST /auth/v1/verify'])
})

test('supabaseLaunch: no profile → friendly refusal, and no link is ever generated', async () => {
  const sb = fakeSupabase(SB)
  const res = await launchApp(ticket({ sub: 'stranger@example.com' }), sb)
  assert.equal(res.statusCode, 403)
  assert.match(res.text, /No Invoice Chaser account for stranger@example\.com/)
  assert.deepEqual(sb.calls, ['GET /rest/v1/profiles'])
})

test('supabaseLaunch: the app\'s own check can refuse', async () => {
  const sb = fakeSupabase(SB)
  const res = await launchApp(ticket(), sb, { check: async p => (p.access_status === 'active' ? { title: 'Access inactive', message: 'Ask an admin.' } : null) })
  assert.equal(res.statusCode, 403)
  assert.match(res.text, /Access inactive/)
  assert.ok(!sb.calls.some(c => c.includes('generate_link')))
})

test('supabaseLaunch: refuses if Supabase would have created a new account', async () => {
  const sb = fakeSupabase({ ...SB, users: {} })
  const logged = console.error; console.error = () => {}
  try {
    const res = await launchApp(ticket(), sb)
    assert.equal(res.statusCode, 502)
    assert.ok(!sb.calls.includes('POST /auth/v1/verify'))
  } finally { console.error = logged }
})

test('supabaseLaunch: refuses on an account mismatch between profile and auth user', async () => {
  const sb = fakeSupabase({ ...SB, users: { 'va@example.com': { id: 'someone-else' } } })
  const logged = console.error; console.error = () => {}
  try { assert.equal((await launchApp(ticket(), sb)).statusCode, 502) } finally { console.error = logged }
})

test('supabaseLaunch: falls back to type "email" when "magiclink" verify is refused', async () => {
  const sb = fakeSupabase({ ...SB, failVerifyType: 'magiclink' })
  const res = await launchApp(ticket(), sb)
  assert.equal(res.statusCode, 302)
  assert.equal(sb.calls.filter(c => c === 'POST /auth/v1/verify').length, 2)
})

test('supabaseLaunch: missing service key → set-up page that offers normal sign-in', async () => {
  const res = await launchApp(ticket(), fakeSupabase(SB), { serviceKey: '' })
  assert.equal(res.statusCode, 503)
  assert.match(res.text, /service key/)
})

test('supabaseLaunch: Supabase errors become a retry page, not a crash', async () => {
  const logged = console.error; console.error = () => {}
  try {
    const res = await launchApp(ticket(), async () => ({ ok: false, status: 500, text: async () => '' }))
    assert.equal(res.statusCode, 502)
    assert.match(res.text, /Try again/)
  } finally { console.error = logged }
})

// ── Automatic accounts (apps that opt in with `provision`) ──

const PROVISION = { admin: 'admin', va: 'member' }
const noWait = async () => {}

test('provision: an assistant without an account gets one, with the assistant role, and is signed in', async () => {
  const sb = fakeSupabase({ profiles: [], users: {}, defaultRole: 'member' })
  const res = await launchApp(ticket({ sub: 'new.va@example.com', name: 'New VA' }), sb, { provision: PROVISION, wait: noWait })
  assert.equal(res.statusCode, 302)
  assert.equal(new URLSearchParams(res.headers.Location.split('#')[1]).get('access_token'), 'AT-new.va@example.com')
  assert.ok(sb.calls.includes('POST /auth/v1/admin/users'))
  assert.ok(!sb.calls.includes('PATCH /rest/v1/profiles'), 'role already matched the default')
})

test('provision: a launcher admin gets the app\'s admin role', async () => {
  const profiles = []
  const sb = fakeSupabase({ profiles, users: {}, defaultRole: 'applicant' })
  const res = await launchApp(ticket({ sub: 'asad@offloadcrew.com', role: 'admin' }), sb, { provision: { admin: 'admin', va: 'applicant' }, wait: noWait })
  assert.equal(res.statusCode, 302)
  assert.equal(profiles[0].role, 'admin')
  assert.equal(profiles[0].full_name, 'asad', 'falls back to the email name when the ticket has none')
  assert.ok(sb.calls.includes('PATCH /rest/v1/profiles'))
})

test('provision: existing accounts are left exactly as they are', async () => {
  const sb = fakeSupabase(SB)
  const res = await launchApp(ticket({ role: 'admin' }), sb, { provision: PROVISION, wait: noWait })
  assert.equal(res.statusCode, 302)
  assert.ok(!sb.calls.includes('POST /auth/v1/admin/users'))
  assert.ok(!sb.calls.includes('PATCH /rest/v1/profiles'))
})

test('provision: apps that do not opt in still refuse, and create nothing', async () => {
  const sb = fakeSupabase({ profiles: [], users: {} })
  const res = await launchApp(ticket({ sub: 'new.va@example.com' }), sb, { wait: noWait })
  assert.equal(res.statusCode, 403)
  assert.ok(!sb.calls.includes('POST /auth/v1/admin/users'))
})

test('provision: a login with no profile, or an app with no sign-up trigger, fails cleanly', async () => {
  const logged = console.error; console.error = () => {}
  try {
    let res = await launchApp(ticket({ sub: 'half@example.com' }), fakeSupabase({ createStatus: 422 }), { provision: PROVISION, wait: noWait })
    assert.equal(res.statusCode, 502)
    res = await launchApp(ticket({ sub: 'half@example.com' }), fakeSupabase({ trigger: false }), { provision: PROVISION, wait: noWait })
    assert.equal(res.statusCode, 502)
    assert.match(res.text, /Could not sign you in/)
  } finally { console.error = logged }
})

test('provisionAccount: waits for the sign-up trigger before giving up', async () => {
  const profiles = []
  const sb = fakeSupabase({ profiles, trigger: false })
  let waits = 0
  const wait = async () => { waits++; if (waits === 2) profiles.push({ id: 'new-1', email: 'late@example.com', role: 'member' }) }
  const p = await provisionAccount({ url: 'https://a.supabase.co', serviceKey: 'service-key', email: 'late@example.com', role: 'member', fetchFn: sb, wait })
  assert.equal(p.id, 'new-1')
  assert.equal(waits, 2)
})

test('callRpc: missing function is reported, not thrown', async () => {
  const sb = fakeSupabase({ rpc: { yes: () => true } })
  assert.deepEqual(await callRpc({ url: 'https://a.supabase.co', serviceKey: 'service-key', fn: 'yes', fetchFn: sb }), { exists: true, value: true })
  assert.deepEqual(await callRpc({ url: 'https://a.supabase.co', serviceKey: 'service-key', fn: 'missing', fetchFn: sb }), { exists: false })
})

test('findProfileByEmail: lowercases, and ignores ambiguous matches', async () => {
  const sb = fakeSupabase({ profiles: [{ id: 1, email: 'a@b.co' }, { id: 2, email: 'dup@b.co' }, { id: 3, email: 'dup@b.co' }] })
  assert.equal((await findProfileByEmail({ url: 'https://a.supabase.co', serviceKey: 'service-key', email: ' A@B.co ', fetchFn: sb })).id, 1)
  assert.equal(await findProfileByEmail({ url: 'https://a.supabase.co', serviceKey: 'service-key', email: 'dup@b.co', fetchFn: sb }), null)
})

test('mintSession: unknown verify failure is an error', async () => {
  const sb = fakeSupabase(SB)
  const broken = async (url, opts) => (url.includes('/verify') ? { ok: false, status: 500, text: async () => '' } : sb(url, opts))
  await assert.rejects(mintSession({ url: 'https://a.supabase.co', serviceKey: 'service-key', email: 'va@example.com', fetchFn: broken }), /verify failed/)
})
