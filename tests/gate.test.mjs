// The staging gate (receiver/_gate.js) and the launcher's send-back-to-staging path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stagingGate, makeGateCookie, readGateCookie, cookieValue, gateSetCookie, setGateCookie, gateEnabled, GATE_COOKIE,
} from '../receiver/_gate.js'
import { previewOrigin, APPS } from '../api/_apps.js'
import launch from '../api/launch.js'
import { verifyTicket } from '../receiver/_launcher.js'
import { generateKeyPair } from '../api/_ticket.js'
import { fakeFetch, fakeRes } from './_helpers.mjs'

const SECRET = 'test-gate-secret'
const NOW = Date.UTC(2026, 9, 17, 23, 0, 0)

function withEnv(vars, fn) {
  const saved = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })
}
const PREVIEW = { VERCEL_ENV: 'preview', LAUNCHER_GATE_SECRET: SECRET, LAUNCHER_URL: 'https://launcher.example' }
const gate = stagingGate({ appName: 'QB Staging', appKey: 'quotes-staging', allow: [/^\/api\/stripe-webhook$/] })
const req = (path, { cookie, accept = 'text/html', method = 'GET' } = {}) =>
  new Request(`https://offload-quote-builder-git-staging-x.vercel.app${path}`, { method, headers: { accept, ...(cookie ? { cookie } : {}) } })

// ── Cookie ──

test('gate cookie: round trip, expiry, tampering, wrong secret, junk', async () => {
  const c = await makeGateCookie('Asad@OffloadCrew.com', SECRET, { now: NOW })
  assert.equal(await readGateCookie(c, SECRET, { now: NOW + 1000 }), 'asad@offloadcrew.com')
  assert.equal(await readGateCookie(c, SECRET, { now: NOW + 13 * 3600 * 1000 }), null, 'expired after 12h')
  assert.equal(await readGateCookie(c, 'other-secret', { now: NOW }), null)
  const [v, email, exp, sig] = c.split('.')
  assert.equal(await readGateCookie([v, email, String(Number(exp) + 99999), sig].join('.'), SECRET, { now: NOW }), null, 'extended expiry is caught')
  const forgedEmail = btoa('omar@offloadcrew.com').replace(/=+$/, '')
  assert.equal(await readGateCookie([v, forgedEmail, exp, sig].join('.'), SECRET, { now: NOW }), null, 'swapped email is caught')
  for (const junk of ['', 'x', 'v1.a.b', 'v2.a.b.c', null, undefined, 'v1.!!.1.!!']) assert.equal(await readGateCookie(junk, SECRET, { now: NOW }), null, String(junk))
  assert.equal(await readGateCookie(c, '', { now: NOW }), null)
})

test('cookieValue and Set-Cookie attributes', () => {
  assert.equal(cookieValue(`a=1; ${GATE_COOKIE}=xyz; b=2`), 'xyz')
  assert.equal(cookieValue('a=1'), null)
  assert.equal(cookieValue(undefined), null)
  assert.match(gateSetCookie('v'), /^offload_gate=v; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/)
})

test('setGateCookie keeps a cookie the route already set (the console session)', async () => {
  const res = fakeRes()
  res.getHeader = k => res.headers[k]
  res.setHeader('Set-Cookie', 'tz_admin=abc; HttpOnly')
  assert.equal(await setGateCookie(res, 'omar@offloadcrew.com', { env: PREVIEW, now: NOW }), true)
  assert.equal(res.headers['Set-Cookie'].length, 2)
  assert.match(res.headers['Set-Cookie'][0], /^tz_admin=/)
  assert.match(res.headers['Set-Cookie'][1], /^offload_gate=v1\./)
  assert.equal(await setGateCookie(fakeRes(), 'x@y.com', { env: { VERCEL_ENV: 'preview' } }), false, 'no secret, no cookie')
})

test('only preview deployments are gated', () => {
  assert.equal(gateEnabled({ VERCEL_ENV: 'preview' }), true)
  assert.equal(gateEnabled({ VERCEL_ENV: 'production' }), false)
  assert.equal(gateEnabled({ VERCEL_ENV: 'development' }), false)
  assert.equal(gateEnabled({}), false)
})

// ── Middleware ──

test('gate: production and local are never touched', async () => {
  await withEnv({ VERCEL_ENV: 'production', LAUNCHER_GATE_SECRET: undefined }, async () => {
    assert.equal(await gate(req('/')), undefined)
  })
  await withEnv({ VERCEL_ENV: undefined }, async () => {
    assert.equal(await gate(req('/')), undefined)
  })
})

test('gate: a preview without the cookie is locked, with a link back through the launcher', async () => {
  await withEnv(PREVIEW, async () => {
    const page = await gate(req('/'))
    assert.equal(page.status, 403)
    const html = await page.text()
    assert.match(html, /QB Staging is for Offload Crew admins/)
    assert.ok(html.includes('https://launcher.example/?open=quotes-staging&amp;origin=https%3A%2F%2Foffload-quote-builder-git-staging-x.vercel.app'))
    assert.equal(page.headers.get('cache-control'), 'no-store')

    const api = await gate(req('/api/quotes', { accept: 'application/json' }))
    assert.equal(api.status, 403)
    assert.match((await api.json()).error, /launcher/i)

    const asset = await gate(req('/assets/index-abc.js', { accept: '*/*' }))
    assert.equal(asset.status, 403, 'files are locked too')
  })
})

test('gate: a valid cookie passes; forged or expired ones do not', async () => {
  await withEnv(PREVIEW, async () => {
    const good = await makeGateCookie('omar@offloadcrew.com', SECRET)
    assert.equal(await gate(req('/', { cookie: `${GATE_COOKIE}=${good}` })), undefined)
    assert.equal(await gate(req('/assets/x.js', { cookie: `other=1; ${GATE_COOKIE}=${good}` })), undefined)
    const forged = await makeGateCookie('omar@offloadcrew.com', 'guessed-secret')
    assert.equal((await gate(req('/', { cookie: `${GATE_COOKIE}=${forged}` }))).status, 403)
    const old = await makeGateCookie('omar@offloadcrew.com', SECRET, { now: Date.now() - 13 * 3600 * 1000 })
    assert.equal((await gate(req('/', { cookie: `${GATE_COOKIE}=${old}` }))).status, 403)
  })
})

test('gate: the sign-in route and allowed callbacks stay reachable', async () => {
  await withEnv(PREVIEW, async () => {
    assert.equal(await gate(req('/api/launch?ticket=x')), undefined)
    assert.equal(await gate(req('/api/stripe-webhook', { method: 'POST', accept: '*/*' })), undefined)
    assert.equal((await gate(req('/api/stripe-webhooks'))).status, 403, 'allow-list is exact')
  })
})

test('gate: missing secret fails closed', async () => {
  await withEnv({ ...PREVIEW, LAUNCHER_GATE_SECRET: undefined }, async () => {
    const page = await gate(req('/'))
    assert.equal(page.status, 503)
    assert.match(await page.text(), /LAUNCHER_GATE_SECRET/)
  })
})

// ── Launcher: back to the exact test site ──

test('previewOrigin: only this app\'s own test addresses', () => {
  const qb = APPS.find(a => a.key === 'quotes-staging')
  const con = APPS.find(a => a.key === 'console-staging')
  assert.equal(previewOrigin(qb, 'https://offload-quote-builder-git-feat-x-cumbretalent-5400s-projects.vercel.app/some/page'), 'https://offload-quote-builder-git-feat-x-cumbretalent-5400s-projects.vercel.app')
  assert.equal(previewOrigin(qb, 'https://offload-quote-builder-abc123-cumbretalent-5400s-projects.vercel.app'), 'https://offload-quote-builder-abc123-cumbretalent-5400s-projects.vercel.app')
  assert.equal(previewOrigin(qb, 'https://quotes-staging.offloadcrew.com'), 'https://quotes-staging.offloadcrew.com')
  for (const bad of [
    'https://evil.example', 'http://offload-quote-builder-git-staging-cumbretalent-5400s-projects.vercel.app',
    'https://offload-quote-builder-git-staging-cumbretalent-5400s-projects.vercel.app.evil.example',
    'https://offload-quote-builder-x-cumbretalent-5400s-projects.vercel.app:8443', 'https://user@offload-quote-builder-x-cumbretalent-5400s-projects.vercel.app',
    'https://tradezip-admin-git-staging-cumbretalent-5400s-projects.vercel.app', 'not a url', '', null,
  ]) assert.equal(previewOrigin(qb, bad), null, String(bad))
  assert.equal(previewOrigin(con, 'https://tradezip-admin-git-staging-cumbretalent-5400s-projects.vercel.app'), 'https://tradezip-admin-git-staging-cumbretalent-5400s-projects.vercel.app')
  assert.equal(previewOrigin(APPS.find(a => a.key === 'quotes'), 'https://offload-quote-builder-x-cumbretalent-5400s-projects.vercel.app'), null, 'live tiles take no origin')
})

const KEYS = generateKeyPair()
const LENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-key', LAUNCHER_SUPERADMIN_EMAILS: 'owner@offloadcrew.com', LAUNCHER_SIGNING_KEY: KEYS.signingKey }
const callLaunch = (token, body) => { const res = fakeRes(); return launch({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res, { env: LENV, fetchFn: fakeFetch }).then(() => res) }

test('launch with origin: ticket goes to that exact test build', async () => {
  const origin = 'https://offload-quote-builder-git-feat-y-cumbretalent-5400s-projects.vercel.app'
  const res = await callLaunch('tok:owner@offloadcrew.com', { app: 'quotes-staging', origin })
  assert.equal(res.statusCode, 200)
  const u = new URL(res.body.url)
  assert.equal(u.origin, origin)
  assert.equal(u.pathname, '/api/launch')
  assert.equal(verifyTicket(u.searchParams.get('ticket'), { publicKey: KEYS.publicKey, audience: 'quotes-staging' }).claims.role, 'admin')
})

test('launch with origin: foreign addresses refused; assistants still get nothing', async () => {
  assert.equal((await callLaunch('tok:owner@offloadcrew.com', { app: 'quotes-staging', origin: 'https://evil.example' })).statusCode, 400)
  assert.equal((await callLaunch('tok:owner@offloadcrew.com', { app: 'quotes', origin: 'https://offload-quote-builder-x-cumbretalent-5400s-projects.vercel.app' })).statusCode, 400)
  assert.equal((await callLaunch('tok:va@example.com', { app: 'quotes-staging', origin: 'https://offload-quote-builder-git-staging-cumbretalent-5400s-projects.vercel.app' })).statusCode, 404)
  const plain = await callLaunch('tok:owner@offloadcrew.com', { app: 'quotes-staging', origin: '' })
  assert.match(plain.body.url, /^https:\/\/offload-quote-builder-git-staging-cumbretalent-5400s-projects\.vercel\.app\/api\/launch\?ticket=/)
})
