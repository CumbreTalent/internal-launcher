// Local stand-in for Vercel + Supabase + the apps, so the launcher's sign-in,
// single sign-on and in-launcher app window can be tried end to end with no
// real project and no credentials:
//
//   npm run dev:mock      → http://localhost:8746
//
// Port 8746 serves the launcher (static files + the real /api handlers) and a
// fake Supabase. Ports 8747–8752 are fake apps that run the REAL sign-in
// receiver (receiver/_launcher.js) against that fake Supabase:
//
//   8747 Quote Builder   8748 Admin Console   8749 Invoice Chaser
//   8750 Crew Training   8751 QB Staging      8752 Admin Staging
//
// Throwaway accounts that exist only in this process:
//   admin@test.local   password: admin-pass-local   → every tile
//   va@test.local      password: va-pass-local      → VA tiles only
//   other@test.local   password: other-pass-local   → signs in, then refused
//
// Nothing here ships: Vercel ignores tests/.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair } from '../api/_ticket.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 8746)
const ORIGIN = `http://localhost:${PORT}`
const SERVICE_KEY = 'mock-service-key'
const KEYS = generateKeyPair()

process.env.SUPABASE_URL = ORIGIN
process.env.SUPABASE_ANON_KEY = 'mock-anon-key'
process.env.LAUNCHER_ADMIN_EMAILS = 'admin@test.local'
process.env.LAUNCHER_VA_EMAILS = 'va@test.local'
process.env.LAUNCHER_SIGNING_KEY = KEYS.signingKey

const USERS = {
  'admin@test.local': { id: 'u-admin', password: 'admin-pass-local' },
  'va@test.local': { id: 'u-va', password: 'va-pass-local' },
  'other@test.local': { id: 'u-other', password: 'other-pass-local' },
}

const { APPS } = await import('../api/_apps.js')
const appsHandler = (await import('../api/apps.js')).default
const configHandler = (await import('../api/config.js')).default
const launchHandler = (await import('../api/launch.js')).default
const { supabaseLaunch, receive, sendPage, sendRedirect } = await import('../receiver/_launcher.js')

// Point the tiles at the fake apps.
const FAKE = {
  quotes: { port: 8747, kind: 'supabase', name: 'Quote Builder' },
  console: { port: 8748, kind: 'cookie', name: 'Admin Console' },
  invoices: { port: 8749, kind: 'supabase', name: 'Invoice Chaser' },
  training: { port: 8750, kind: 'supabase', name: 'Crew Training' },
  'quotes-staging': { port: 8751, kind: 'supabase', name: 'QB Staging' },
  'console-staging': { port: 8752, kind: 'cookie', name: 'Admin Staging' },
}
for (const a of APPS) if (FAKE[a.key]) a.legacy = a.custom = `http://localhost:${FAKE[a.key].port}`

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
function vercelRes(res) {
  res.status = c => { res.statusCode = c; return res }
  res.json = b => json(res, res.statusCode || 200, b)
  return res
}
async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return {} }
}
function tokensFor(email) {
  return {
    access_token: 'access-' + email, refresh_token: 'refresh-' + email, token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USERS[email].id, email },
  }
}
const isService = req => req.headers.apikey === SERVICE_KEY && req.headers.authorization === `Bearer ${SERVICE_KEY}`

// ── Launcher + fake Supabase on 8746 ──
const issued = new Map()
const launcher = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN)
  const p = url.pathname

  if (p === '/api/apps') return appsHandler(req, vercelRes(res))
  if (p === '/api/config') return configHandler(req, vercelRes(res))
  if (p === '/api/launch') { req.body = await readBody(req); return launchHandler(req, vercelRes(res)) }

  // Supabase Auth
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const body = await readBody(req)
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const email = String(body.email || '').toLowerCase()
      if (USERS[email] && USERS[email].password === body.password) return json(res, 200, tokensFor(email))
      return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    if (grant === 'refresh_token') {
      const m = /^refresh-(.+)$/.exec(String(body.refresh_token || ''))
      if (m && USERS[m[1]]) return json(res, 200, tokensFor(m[1]))
      return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
    }
    return json(res, 400, { error: 'unsupported_grant_type' })
  }
  if (p === '/auth/v1/user') {
    const m = /^Bearer access-(.+)$/.exec(req.headers.authorization || '')
    if (m && USERS[m[1]]) return json(res, 200, { id: USERS[m[1]].id, email: m[1], aud: 'authenticated' })
    return json(res, 401, { code: 401, msg: 'invalid JWT' })
  }
  if (p === '/auth/v1/logout') { res.statusCode = 204; return res.end() }
  if (p === '/auth/v1/admin/generate_link' && req.method === 'POST') {
    if (!isService(req)) return json(res, 401, { msg: 'service key required' })
    const { email } = await readBody(req)
    if (!USERS[email]) return json(res, 422, { msg: 'mock: unknown user' })
    const hashed = 'hash-' + Math.random().toString(36).slice(2)
    issued.set(hashed, email)
    return json(res, 200, { id: USERS[email].id, email, hashed_token: hashed, verification_type: 'magiclink' })
  }
  if (p === '/auth/v1/verify' && req.method === 'POST') {
    const { token_hash } = await readBody(req)
    const email = issued.get(token_hash)
    if (!email) return json(res, 400, { msg: 'Email link is invalid or has expired' })
    issued.delete(token_hash)
    return json(res, 200, tokensFor(email))
  }
  // PostgREST: every test account has a profile in every app except "other".
  if (p === '/rest/v1/profiles') {
    if (!isService(req)) return json(res, 401, { msg: 'service key required' })
    const email = (url.searchParams.get('email') || '').replace(/^eq\./, '')
    const rows = USERS[email] && email !== 'other@test.local' ? [{ id: USERS[email].id, email, access_status: 'active' }] : []
    return json(res, 200, rows)
  }
  if (p.startsWith('/rest/v1/rpc/')) return json(res, 404, { code: 'PGRST202', message: 'mock: no such function' })

  // Static launcher files
  const rel = p === '/' ? '/index.html' : decodeURIComponent(p)
  const file = path.join(ROOT, path.normalize(rel))
  const blocked = !file.startsWith(ROOT + path.sep) || /^\/(api|tests|receiver|scripts|node_modules|\.git|\.claude)(\/|$)/.test(rel) || /^\/\.(env|launcher-keys)/.test(rel)
  if (blocked || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('Not found') }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  fs.createReadStream(file).pipe(res)
})

// ── Fake apps on 8747–8752 ──
function appPage(app, port) {
  const storageKey = `mock-${port}-session`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${app.name}</title>
<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f6f7fb;color:#141824}
header{background:#141824;color:#fff;padding:14px 18px;font-weight:600}main{padding:24px 18px;max-width:640px}
.ok{background:#e7f6ec;border:1px solid #a9dcb9;border-radius:12px;padding:16px}.no{background:#fff3e6;border:1px solid #f2c38b;border-radius:12px;padding:16px}
button{font:inherit;margin-top:12px;padding:8px 12px;border-radius:8px;border:1px solid #ccd;background:#fff;cursor:pointer}</style></head>
<body><header>${app.name} <small style="opacity:.6;font-weight:400">· mock app on port ${port}</small></header><main id="m">Loading…</main>
<script>
${app.kind === 'supabase' ? `
  // What supabase-js does with detectSessionInUrl: take the session from the
  // fragment, store it, and clean the address bar.
  const f = new URLSearchParams(location.hash.slice(1))
  if (f.get('access_token') && f.get('refresh_token')) {
    localStorage.setItem('${storageKey}', JSON.stringify({ access_token: f.get('access_token'), via: 'launcher' }))
    history.replaceState(null, '', location.pathname)
  }
  const s = JSON.parse(localStorage.getItem('${storageKey}') || 'null')
  render(s && s.access_token.replace(/^access-/, ''))
  window.signOutHere = () => { localStorage.removeItem('${storageKey}'); render(null) }
` : `
  fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => render(d && d.email))
  window.signOutHere = () => fetch('/api/logout', { method: 'POST' }).then(() => render(null))
`}
  function render(email) {
    document.getElementById('m').innerHTML = email
      ? '<div class="ok"><strong>Signed in as ' + email + '</strong><br>No password was asked: the launcher signed you in.<br><button onclick="signOutHere()">Sign out of this app</button></div>'
      : '<div class="no"><strong>Not signed in.</strong><br>This is where ${app.name}\\'s own login screen would be.</div>'
  }
</script></body></html>`
}

function fakeApp(key, app) {
  const env = { LAUNCHER_PUBLIC_KEY: KEYS.publicKey, LAUNCHER_URL: ORIGIN }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${app.port}`)
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${ORIGIN}`)
    if (url.pathname === '/api/launch') {
      if (app.kind === 'supabase') {
        return supabaseLaunch(req, res, { appName: app.name, audience: key, supabaseUrl: ORIGIN, serviceKey: SERVICE_KEY, env })
      }
      const claims = receive(req, res, { appName: app.name, audience: key, env })
      if (!claims) return
      if (claims.role !== 'admin') return sendPage(res, 403, { title: 'Admins only', message: `${claims.sub} is not an admin in the launcher.`, launcherUrl: ORIGIN })
      res.setHeader('Set-Cookie', `mock_console=${encodeURIComponent(claims.sub)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
      return sendRedirect(res, '/')
    }
    if (url.pathname === '/api/me') {
      const m = /(?:^|;\s*)mock_console=([^;]+)/.exec(req.headers.cookie || '')
      return m ? json(res, 200, { ok: true, email: decodeURIComponent(m[1]) }) : json(res, 401, { error: 'Not signed in' })
    }
    if (url.pathname === '/api/logout') {
      res.setHeader('Set-Cookie', 'mock_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
      return json(res, 200, { ok: true })
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(appPage(app, app.port))
  })
}

launcher.listen(PORT, () => {
  console.log(`Launcher mock running at ${ORIGIN}`)
  console.log('Accounts: admin@test.local / va@test.local / other@test.local (passwords at the top of tests/mock-server.mjs)')
})
for (const [key, app] of Object.entries(FAKE)) {
  fakeApp(key, app).listen(app.port, () => console.log(`  fake ${app.name} on http://localhost:${app.port}`))
}
