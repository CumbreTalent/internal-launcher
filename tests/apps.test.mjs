import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, roleFor, tilesFor, tileUrl } from '../api/_apps.js'
import { verifyUser, bearerToken } from '../api/_auth.js'
import handler from '../api/apps.js'

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  LAUNCHER_ADMIN_EMAILS: 'Owner@Offloadcrew.com',
  LAUNCHER_VA_EMAILS: ' va@example.com , second.va@example.com ',
}

// Fake Supabase: a token of the form "tok:<email>" is valid for that email.
const fakeFetch = async (url, opts) => {
  assert.ok(url.endsWith('/auth/v1/user'), `unexpected url ${url}`)
  assert.equal(opts.headers.apikey, ENV.SUPABASE_ANON_KEY)
  const m = /^Bearer tok:(.+)$/.exec(opts.headers.Authorization || '')
  if (!m) return { ok: false, status: 401, json: async () => ({ msg: 'invalid JWT' }) }
  return { ok: true, status: 200, json: async () => ({ id: 'id-' + m[1], email: m[1] }) }
}

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v },
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
}
const req = (token, method = 'GET') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {} })
const call = (r, deps = {}) => { const res = fakeRes(); return handler(r, res, { env: ENV, fetchFn: fakeFetch, ...deps }).then(() => res) }

test('roleFor: allowlists are case-insensitive and whitespace-tolerant', () => {
  assert.equal(roleFor('owner@offloadcrew.com', ENV), 'admin')
  assert.equal(roleFor('  VA@example.com ', ENV), 'va')
  assert.equal(roleFor('second.va@example.com', ENV), 'va')
  assert.equal(roleFor('customer@contractor.com', ENV), null)
  assert.equal(roleFor('', ENV), null)
  assert.equal(roleFor(undefined, ENV), null)
})

test('roleFor: admin wins when an email is on both lists', () => {
  assert.equal(roleFor('both@x.com', { LAUNCHER_ADMIN_EMAILS: 'both@x.com', LAUNCHER_VA_EMAILS: 'both@x.com' }), 'admin')
})

test('roleFor: nobody gets in when the lists are unset', () => {
  assert.equal(roleFor('owner@offloadcrew.com', {}), null)
})

test('tilesFor: VA never receives staging or console tiles', () => {
  const va = tilesFor('va', ENV)
  assert.deepEqual(va.map(t => t.label), ['Quote Builder', 'Crew Training', 'Invoice Chaser', 'Workflows'])
  for (const t of va) {
    assert.ok(!/staging|tradezip-admin|console/i.test(t.url), `VA tile leaks ${t.url}`)
    assert.equal(t.badge, null)
  }
})

test('tilesFor: admin receives every tile in order', () => {
  const admin = tilesFor('admin', ENV)
  assert.equal(admin.length, APPS.length)
  assert.deepEqual(admin.map(t => t.label), APPS.map(a => a.label))
  assert.equal(admin.find(t => t.label === 'QB Staging').badge, 'TEST')
})

test('tilesFor: unknown role gets nothing', () => {
  assert.deepEqual(tilesFor(null, ENV), [])
  assert.deepEqual(tilesFor('superuser', ENV), [])
})

test('tilesFor: only the browser-safe fields are returned', () => {
  for (const t of tilesFor('admin', ENV)) {
    assert.deepEqual(Object.keys(t).sort(), ['badge', 'color', 'icon', 'label', 'url'])
  }
})

test('custom-domain toggle switches every external tile, leaves Workflows alone', () => {
  const legacy = tilesFor('admin', ENV)
  const custom = tilesFor('admin', { ...ENV, LAUNCHER_USE_CUSTOM_DOMAINS: '1' })
  for (const t of legacy) if (t.label !== 'Workflows') assert.match(t.url, /\.vercel\.app/)
  for (const t of custom) if (t.label !== 'Workflows') assert.match(t.url, /^https:\/\/[a-z-]+\.offloadcrew\.com$/)
  assert.equal(legacy.find(t => t.label === 'Workflows').url, '/workflow.html')
  assert.equal(custom.find(t => t.label === 'Workflows').url, '/workflow.html')
  const wf = APPS.find(a => a.key === 'workflows')
  assert.equal(tileUrl(wf, true), '/workflow.html')
})

test('every tile has a legacy and custom address, or a same-host url', () => {
  for (const a of APPS) {
    if (a.url) { assert.match(a.url, /^\//); continue }
    assert.match(a.legacy, /^https:\/\//)
    assert.match(a.custom, /^https:\/\/[a-z-]+\.offloadcrew\.com$/)
  }
})

test('bearerToken parses the header and tolerates junk', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc')
  assert.equal(bearerToken({ headers: { authorization: 'bearer   abc  ' } }), 'abc')
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), '')
  assert.equal(bearerToken({ headers: {} }), '')
  assert.equal(bearerToken({}), '')
})

test('verifyUser: valid, invalid, and unreachable', async () => {
  const opts = { url: ENV.SUPABASE_URL + '/', anon: ENV.SUPABASE_ANON_KEY, fetchFn: fakeFetch }
  assert.deepEqual(await verifyUser('tok:va@example.com', opts), { id: 'id-va@example.com', email: 'va@example.com' })
  assert.equal(await verifyUser('garbage', opts), null)
  assert.equal(await verifyUser('', opts), null)
  await assert.rejects(verifyUser('tok:x', { ...opts, fetchFn: async () => { throw new Error('ECONNRESET') } }))
  await assert.rejects(verifyUser('tok:x', { ...opts, fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }) }))
})

test('GET /api/apps without a token → 401', async () => {
  const res = await call(req(null))
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('GET /api/apps with a bad token → 401', async () => {
  const res = await call(req('nope'))
  assert.equal(res.statusCode, 401)
})

test('GET /api/apps as an unlisted account → 403, no tiles', async () => {
  const res = await call(req('tok:customer@contractor.com'))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.apps, undefined)
})

test('GET /api/apps as the VA → 200 with only VA tiles', async () => {
  const res = await call(req('tok:VA@example.com'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.role, 'va')
  assert.equal(res.body.email, 'VA@example.com')
  assert.deepEqual(res.body.apps.map(t => t.label), ['Quote Builder', 'Crew Training', 'Invoice Chaser', 'Workflows'])
})

test('GET /api/apps as the admin → 200 with every tile', async () => {
  const res = await call(req('tok:owner@offloadcrew.com'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.role, 'admin')
  assert.equal(res.body.apps.length, APPS.length)
})

test('POST /api/apps → 405', async () => {
  const res = await call(req('tok:owner@offloadcrew.com', 'POST'))
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.Allow, 'GET')
})

test('missing Supabase settings → 500 before any network call', async () => {
  const res = await call(req('tok:owner@offloadcrew.com'), { env: { ...ENV, SUPABASE_ANON_KEY: '' }, fetchFn: async () => { throw new Error('should not be called') } })
  assert.equal(res.statusCode, 500)
})

test('Supabase unreachable → 502, not 401', async () => {
  const res = await call(req('tok:owner@offloadcrew.com'), { fetchFn: async () => { throw new Error('ECONNRESET') } })
  assert.equal(res.statusCode, 502)
})
