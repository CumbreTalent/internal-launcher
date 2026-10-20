import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, roleFor, tilesFor, tileUrl, appFor, ticketRole, isSuperadminEmail, allowed, previewOrigin } from '../api/_apps.js'
import { verifyUser, bearerToken } from '../api/_auth.js'
import handler from '../api/apps.js'
import { fakeFetch, fakeRes, ENV } from './_helpers.mjs'

const VA_LABELS = ['Quote Builder', 'Crew Training', 'Invoice Chaser', 'Workflows']
const ADMIN_LABELS = ['Quote Builder', 'QB Staging', 'Admin Staging', 'Crew Training', 'Invoice Chaser', 'Workflows']
const SUPER_LABELS = [...ADMIN_LABELS, 'People']

const req = (token, method = 'GET') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {} })
const call = (r, deps = {}) => { const res = fakeRes(); return handler(r, res, { env: ENV, fetchFn: fakeFetch, ...deps }).then(() => res) }
const u = (email, launcher_role) => ({ email, appMetadata: launcher_role ? { launcher_role } : {} })

// ── Roles ──

test('roleFor: super admin comes only from the setting, case- and space-tolerant', () => {
  assert.equal(roleFor(u('owner@offloadcrew.com'), ENV), 'superadmin')
  assert.equal(roleFor(u('  OWNER@offloadcrew.com '), ENV), 'superadmin')
  assert.equal(roleFor(u('owner@offloadcrew.com', 'va'), ENV), 'superadmin', 'the setting wins over the account')
  assert.equal(isSuperadminEmail('owner@offloadcrew.com', { LAUNCHER_SUPERADMIN_EMAILS: 'a@x.com, owner@offloadcrew.com' }), true)
})

test('roleFor: admins and assistants come from the account', () => {
  assert.equal(roleFor(u('asad@x.com', 'admin'), ENV), 'admin')
  assert.equal(roleFor(u('va@x.com', 'va'), ENV), 'va')
})

test('roleFor: an account can never make itself super admin, and junk roles mean no access', () => {
  assert.equal(roleFor(u('sneaky@x.com', 'superadmin'), ENV), null)
  assert.equal(roleFor(u('x@x.com', 'owner'), ENV), null)
  assert.equal(roleFor(u('customer@contractor.com'), ENV), null)
  assert.equal(roleFor(u(''), ENV), null)
  assert.equal(roleFor(null, ENV), null)
  assert.equal(roleFor(u('owner@offloadcrew.com'), {}), null, 'no super admin without the setting')
})

test('ticketRole: apps only ever see admin or va', () => {
  assert.equal(ticketRole('superadmin'), 'admin')
  assert.equal(ticketRole('admin'), 'admin')
  assert.equal(ticketRole('va'), 'va')
})

// ── Tiles ──

test('tilesFor: each role sees exactly its tiles, in order', () => {
  assert.deepEqual(tilesFor('va', ENV).map(t => t.label), VA_LABELS)
  assert.deepEqual(tilesFor('admin', ENV).map(t => t.label), ADMIN_LABELS)
  assert.deepEqual(tilesFor('superadmin', ENV).map(t => t.label), SUPER_LABELS)
  assert.deepEqual(tilesFor(null, ENV), [])
  assert.deepEqual(tilesFor('owner', ENV), [])
})

test('tilesFor: assistants never receive staging, console or People addresses', () => {
  for (const t of tilesFor('va', ENV)) {
    assert.ok(!/staging|tradezip-admin|console|people/i.test(t.url), `VA tile leaks ${t.url}`)
    assert.ok(!/staging|console|people/.test(t.key), `VA tile leaks key ${t.key}`)
    assert.equal(t.badge, null)
  }
})

test('People is super-admin only, in tiles and in appFor', () => {
  assert.ok(!tilesFor('admin', ENV).some(t => t.key === 'people'))
  assert.equal(appFor('people', 'admin'), null)
  assert.equal(appFor('people', 'va'), null)
  assert.equal(appFor('people', 'superadmin').url, '/people.html')
})

test('hidden tiles reach nobody: the live Admin Console is hidden from everyone', () => {
  assert.equal(APPS.find(a => a.key === 'console').hidden, true)
  for (const role of ['superadmin', 'admin', 'va']) {
    assert.ok(!tilesFor(role, ENV).some(t => t.key === 'console'), role)
    assert.equal(appFor('console', role), null, role)
  }
})

test('the CRM tiles stay hidden, and cannot be launched, until the CRM is deployed', () => {
  for (const key of ['crm', 'crm-staging']) {
    assert.equal(APPS.find(a => a.key === key).hidden, true, key)
    for (const role of ['superadmin', 'admin', 'va']) {
      assert.ok(!tilesFor(role, ENV).some(t => t.key === key), `${key} ${role}`)
      assert.equal(appFor(key, role), null, `${key} ${role}`)
    }
  }
})

test('once unhidden: assistants get the CRM but never CRM Staging', () => {
  const shown = key => ({ ...APPS.find(a => a.key === key), hidden: false })
  const crm = shown('crm')
  const crmStaging = shown('crm-staging')
  assert.equal(allowed(crm, 'va'), true)
  assert.equal(allowed(crmStaging, 'va'), false)
  for (const role of ['admin', 'superadmin']) {
    assert.equal(allowed(crm, role), true, role)
    assert.equal(allowed(crmStaging, role), true, role)
  }
  assert.equal(crm.embed, true)
  assert.equal(crmStaging.embed, false)
  assert.equal(tileUrl(crm, true), 'https://crm.offloadcrew.com')
  assert.equal(tileUrl(crmStaging, true), 'https://crm-staging.offloadcrew.com')
})

test('CRM Staging only sends tickets to the CRM\'s own test addresses', () => {
  const crmStaging = APPS.find(a => a.key === 'crm-staging')
  assert.equal(previewOrigin(crmStaging, 'https://offload-crm-git-staging-cumbretalent-5400s-projects.vercel.app'), 'https://offload-crm-git-staging-cumbretalent-5400s-projects.vercel.app')
  assert.equal(previewOrigin(crmStaging, 'https://offload-crm-abc123-cumbretalent-5400s-projects.vercel.app'), 'https://offload-crm-abc123-cumbretalent-5400s-projects.vercel.app')
  assert.equal(previewOrigin(crmStaging, 'https://crm-staging.offloadcrew.com'), 'https://crm-staging.offloadcrew.com')
  assert.equal(previewOrigin(crmStaging, 'https://crm.offloadcrew.com'), null, 'not the live CRM')
  assert.equal(previewOrigin(crmStaging, 'https://offload-quote-builder-x-cumbretalent-5400s-projects.vercel.app'), null, 'not another app')
  assert.equal(previewOrigin(crmStaging, 'https://offload-crm-x-cumbretalent-5400s-projects.vercel.app.evil.com'), null)
  assert.equal(previewOrigin(crmStaging, 'http://crm-staging.offloadcrew.com'), null, 'https only')
})

test('tilesFor: only the browser-safe fields are returned', () => {
  for (const t of tilesFor('superadmin', ENV)) {
    assert.deepEqual(Object.keys(t).sort(), ['badge', 'color', 'embed', 'icon', 'key', 'label', 'url'])
  }
})

test('staging tiles open in a tab; everything else may open inside the launcher', () => {
  const byKey = Object.fromEntries(tilesFor('superadmin', ENV).map(t => [t.key, t]))
  assert.equal(byKey['quotes-staging'].embed, false)
  assert.equal(byKey['console-staging'].embed, false)
  for (const k of ['quotes', 'training', 'invoices', 'workflows', 'people']) assert.equal(byKey[k].embed, true, k)
})

test('appFor: admin-only apps need admin or above; unknown keys resolve to nothing', () => {
  assert.equal(appFor('quotes-staging', 'va'), null)
  assert.equal(appFor('console-staging', 'va'), null)
  assert.equal(appFor('nope', 'superadmin'), null)
  assert.equal(appFor('quotes', 'va').key, 'quotes')
  assert.equal(appFor('console-staging', 'admin').key, 'console-staging')
  assert.equal(appFor('console-staging', 'superadmin').key, 'console-staging')
  assert.equal(appFor('quotes', null), null)
})

test('custom-domain toggle switches every external tile, leaves launcher pages alone', () => {
  const legacy = tilesFor('superadmin', ENV)
  const custom = tilesFor('superadmin', { ...ENV, LAUNCHER_USE_CUSTOM_DOMAINS: '1' })
  const local = new Set(['Workflows', 'People'])
  for (const t of legacy) if (!local.has(t.label)) assert.match(t.url, /\.vercel\.app/)
  for (const t of custom) if (!local.has(t.label)) assert.match(t.url, /^https:\/\/[a-z-]+\.offloadcrew\.com$/)
  assert.equal(custom.find(t => t.label === 'Workflows').url, '/workflow.html')
  assert.equal(custom.find(t => t.label === 'People').url, '/people.html')
  assert.equal(tileUrl(APPS.find(a => a.key === 'workflows'), true), '/workflow.html')
})

test('every tile has a legacy and custom address, or a same-host url; keys are unique', () => {
  const keys = new Set()
  for (const a of APPS) {
    assert.ok(!keys.has(a.key), `duplicate key ${a.key}`)
    keys.add(a.key)
    if (a.url) { assert.match(a.url, /^\//); continue }
    assert.match(a.legacy, /^https:\/\//)
    assert.match(a.custom, /^https:\/\/[a-z-]+\.offloadcrew\.com$/)
  }
})

// ── Session check ──

test('bearerToken parses the header and tolerates junk', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc')
  assert.equal(bearerToken({ headers: { authorization: 'bearer   abc  ' } }), 'abc')
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), '')
  assert.equal(bearerToken({ headers: {} }), '')
  assert.equal(bearerToken({}), '')
})

test('verifyUser: returns name and account role data; invalid and unreachable handled', async () => {
  const opts = { url: ENV.SUPABASE_URL + '/', anon: ENV.SUPABASE_ANON_KEY, fetchFn: fakeFetch }
  assert.deepEqual(await verifyUser('tok:va@example.com', opts), {
    id: 'id-va@example.com', email: 'va@example.com', name: 'Name va@example.com', appMetadata: { launcher_role: 'va' },
  })
  assert.equal(await verifyUser('garbage', opts), null)
  assert.equal(await verifyUser('', opts), null)
  await assert.rejects(verifyUser('tok:x', { ...opts, fetchFn: async () => { throw new Error('ECONNRESET') } }))
  await assert.rejects(verifyUser('tok:x', { ...opts, fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }) }))
})

// ── GET /api/apps ──

test('GET /api/apps without a token → 401', async () => {
  const res = await call(req(null))
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('GET /api/apps with a bad token → 401', async () => {
  assert.equal((await call(req('nope'))).statusCode, 401)
})

test('GET /api/apps for an account without a launcher role → 403, no tiles', async () => {
  for (const who of ['customer@contractor.com', 'weird@example.com']) {
    const res = await call(req(`tok:${who}`))
    assert.equal(res.statusCode, 403, who)
    assert.equal(res.body.apps, undefined)
  }
})

test('GET /api/apps returns each role its own tiles and label data', async () => {
  let res = await call(req('tok:VA@example.com'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.role, 'va')
  assert.deepEqual(res.body.apps.map(t => t.label), VA_LABELS)

  res = await call(req('tok:admin2@example.com'))
  assert.equal(res.body.role, 'admin')
  assert.deepEqual(res.body.apps.map(t => t.label), ADMIN_LABELS)

  res = await call(req('tok:owner@offloadcrew.com'))
  assert.equal(res.body.role, 'superadmin')
  assert.equal(res.body.name, 'Name owner@offloadcrew.com')
  assert.deepEqual(res.body.apps.map(t => t.label), SUPER_LABELS)
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
