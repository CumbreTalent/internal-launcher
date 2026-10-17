// Local stand-in for Vercel + Supabase + the apps, so the launcher can be tried
// end to end with no real project and no credentials:
//
//   npm run dev:mock      → http://localhost:8746
//
// Port 8746 serves the launcher (static files + the real /api handlers) and a
// fake Supabase with one project per app: the Quote Builder (also the
// launcher's sign-in) at the root, the others under /sb/<app>. Ports
// 8747–8752 are fake apps running the REAL receiver (receiver/_launcher.js),
// including automatic accounts in Invoice Chaser and Crew Training.
//
//   8747 Quote Builder   8748 Admin Console (hidden tile)   8749 Invoice Chaser
//   8750 Crew Training   8751 QB Staging                    8752 Admin Staging
//
// Throwaway sign-ins that exist only in this process:
//   super@test.local   super-pass-local   → super admin (from the setting): every tile + People
//   admin@test.local   admin-pass-local   → admin (on the account)
//   va@test.local      va-pass-local      → assistant (on the account)
//   other@test.local   other-pass-local   → a login with no launcher access
// Nobody but the super admin has Invoice Chaser or Crew Training accounts yet,
// so opening those shows the automatic accounts at work.
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

Object.assign(process.env, {
  SUPABASE_URL: ORIGIN,
  SUPABASE_ANON_KEY: 'mock-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  LAUNCHER_SUPERADMIN_EMAILS: 'super@test.local',
  LAUNCHER_SIGNING_KEY: KEYS.signingKey,
})

// ── Fake Supabase projects ──
let seq = 0
const newId = () => 'u' + ++seq
function project(defaultRole, people) {
  const p = { defaultRole, users: new Map(), profiles: [] }
  for (const [email, { password, launcher_role, role, name }] of Object.entries(people)) {
    const id = newId()
    p.users.set(email, { id, email, password, app_metadata: launcher_role ? { launcher_role } : {}, user_metadata: { full_name: name }, last_sign_in_at: null })
    if (role) p.profiles.push({ id, email, role, full_name: name })
  }
  return p
}
const PROJECTS = {
  quotes: project('offload_va', {
    'super@test.local': { password: 'super-pass-local', role: 'admin', name: 'Sam Super' },
    'admin@test.local': { password: 'admin-pass-local', launcher_role: 'admin', role: 'admin', name: 'Ada Admin' },
    'va@test.local': { password: 'va-pass-local', launcher_role: 'va', role: 'offload_va', name: 'Val Assistant' },
    'other@test.local': { password: 'other-pass-local', role: 'manager', name: 'Oli Other' },
  }),
  invoices: project('member', { 'super@test.local': { role: 'admin', name: 'Sam Super' } }),
  training: project('applicant', { 'super@test.local': { role: 'admin', name: 'Sam Super' } }),
  'quotes-staging': project('offload_va', { 'super@test.local': { role: 'admin', name: 'Sam Super' }, 'admin@test.local': { role: 'admin', name: 'Ada Admin' } }),
}
const projectUrl = key => (key === 'quotes' ? ORIGIN : `${ORIGIN}/sb/${key}`)
const tokenFor = (key, email) => `access-${key}:${email}`
const userFromToken = (key, header) => {
  const m = /^Bearer access-([\w-]+):(.+)$/.exec(header || '')
  return m && m[1] === key ? PROJECTS[key].users.get(m[2]) : null
}

const { APPS } = await import('../api/_apps.js')
const handlers = {
  '/api/apps': (await import('../api/apps.js')).default,
  '/api/config': (await import('../api/config.js')).default,
  '/api/launch': (await import('../api/launch.js')).default,
  '/api/people': (await import('../api/people.js')).default,
}
const { supabaseLaunch, receive, sendPage, sendRedirect } = await import('../receiver/_launcher.js')

const FAKE = {
  quotes: { port: 8747, kind: 'supabase', name: 'Quote Builder' },
  console: { port: 8748, kind: 'cookie', name: 'Admin Console' },
  invoices: { port: 8749, kind: 'supabase', name: 'Invoice Chaser', provision: { admin: 'admin', va: 'member' } },
  training: { port: 8750, kind: 'supabase', name: 'Crew Training', provision: { admin: 'admin', va: 'applicant' } },
  'quotes-staging': { port: 8751, kind: 'supabase', name: 'QB Staging' },
  'console-staging': { port: 8752, kind: 'cookie', name: 'Admin Staging' },
}
for (const a of APPS) if (FAKE[a.key]) a.legacy = a.custom = `http://localhost:${FAKE[a.key].port}`

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}
function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(body === undefined ? '' : JSON.stringify(body))
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
const session = (key, email) => ({
  access_token: tokenFor(key, email), refresh_token: `refresh-${key}:${email}`, token_type: 'bearer',
  expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { email },
})
const isService = req => req.headers.apikey === SERVICE_KEY && req.headers.authorization === `Bearer ${SERVICE_KEY}`
const publicUser = u => ({ id: u.id, email: u.email, app_metadata: u.app_metadata, user_metadata: u.user_metadata, last_sign_in_at: u.last_sign_in_at, aud: 'authenticated' })

const issued = new Map()
async function supabase(key, p, req, res, url) {
  const P = PROJECTS[key]
  const method = req.method
  if (p === '/auth/v1/token' && method === 'POST') {
    const body = await readBody(req)
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const u = P.users.get(String(body.email || '').toLowerCase())
      if (u && u.password && u.password === body.password) { u.last_sign_in_at = new Date().toISOString(); return json(res, 200, session(key, u.email)) }
      return json(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    if (grant === 'refresh_token') {
      const m = /^refresh-([\w-]+):(.+)$/.exec(String(body.refresh_token || ''))
      if (m && m[1] === key && P.users.get(m[2])) return json(res, 200, session(key, m[2]))
      return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
    }
    return json(res, 400, { error: 'unsupported_grant_type' })
  }
  if (p === '/auth/v1/user') {
    const u = userFromToken(key, req.headers.authorization)
    if (!u) return json(res, 403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' })
    if (method === 'PUT') {
      const { password } = await readBody(req)
      if (password === u.password) return json(res, 422, { msg: 'New password should be different from the old password.' })
      u.password = password
    }
    return json(res, 200, publicUser(u))
  }
  if (p === '/auth/v1/logout') { res.statusCode = 204; return res.end() }

  // Everything below needs the service key.
  if (!isService(req)) return json(res, 401, { msg: 'service key required' })
  if (p === '/auth/v1/admin/users' && method === 'GET') {
    return json(res, 200, { users: url.searchParams.get('page') === '1' ? [...P.users.values()].map(publicUser) : [] })
  }
  if (p === '/auth/v1/admin/users' && method === 'POST') {
    const b = await readBody(req)
    if (P.users.has(b.email)) return json(res, 422, { msg: 'A user with this email address has already been registered' })
    const u = { id: newId(), email: b.email, password: b.password || null, app_metadata: b.app_metadata || {}, user_metadata: b.user_metadata || {}, last_sign_in_at: null }
    P.users.set(b.email, u)
    P.profiles.push({ id: u.id, email: u.email, role: P.defaultRole, full_name: u.user_metadata.full_name }) // sign-up trigger
    return json(res, 200, publicUser(u))
  }
  const um = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(p)
  if (um && method === 'PUT') {
    const u = [...P.users.values()].find(x => x.id === decodeURIComponent(um[1]))
    if (!u) return json(res, 404, { msg: 'User not found' })
    const b = await readBody(req)
    if (b.app_metadata) for (const [k, v] of Object.entries(b.app_metadata)) { if (v === null) delete u.app_metadata[k]; else u.app_metadata[k] = v }
    if (b.password) u.password = b.password
    return json(res, 200, publicUser(u))
  }
  if (p === '/auth/v1/admin/generate_link' && method === 'POST') {
    const { email } = await readBody(req)
    const u = P.users.get(email)
    if (!u) return json(res, 200, { id: 'would-create', email, hashed_token: 'x', verification_type: 'signup' })
    const hashed = 'hash-' + Math.random().toString(36).slice(2)
    issued.set(hashed, [key, email])
    return json(res, 200, { id: u.id, email, hashed_token: hashed, verification_type: 'magiclink' })
  }
  if (p === '/auth/v1/verify' && method === 'POST') {
    const { token_hash } = await readBody(req)
    const hit = issued.get(token_hash)
    if (!hit || hit[0] !== key) return json(res, 400, { msg: 'Email link is invalid or has expired' })
    issued.delete(token_hash)
    P.users.get(hit[1]).last_sign_in_at = new Date().toISOString()
    return json(res, 200, session(key, hit[1]))
  }
  if (p === '/rest/v1/profiles') {
    const byEmail = (url.searchParams.get('email') || '').replace(/^eq\./, '')
    const byId = (url.searchParams.get('id') || '').replace(/^eq\./, '')
    const rows = P.profiles.filter(r => (byEmail && r.email === byEmail) || (byId && r.id === byId))
    if (method === 'PATCH') { const b = await readBody(req); rows.forEach(r => Object.assign(r, b)); res.statusCode = 204; return res.end() }
    return json(res, 200, rows)
  }
  if (p.startsWith('/rest/v1/rpc/')) return json(res, 404, { code: 'PGRST202', message: 'mock: no such function' })
  return json(res, 404, { msg: 'mock: unknown endpoint ' + p })
}

// ── Launcher + fake Supabase on 8746 ──
const launcher = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN)
  const p = url.pathname

  if (handlers[p]) {
    if (req.method !== 'GET' && req.method !== 'HEAD') req.body = await readBody(req)
    return handlers[p](req, vercelRes(res))
  }
  const sb = /^\/sb\/([\w-]+)(\/.*)$/.exec(p)
  if (sb && PROJECTS[sb[1]]) return supabase(sb[1], sb[2], req, res, url)
  if (p.startsWith('/auth/v1/') || p.startsWith('/rest/v1/')) return supabase('quotes', p, req, res, url)

  const rel = p === '/' ? '/index.html' : decodeURIComponent(p)
  const file = path.join(ROOT, path.normalize(rel))
  const blocked = !file.startsWith(ROOT + path.sep) || /^\/(api|tests|receiver|scripts|node_modules|supabase|\.git|\.claude)(\/|$)/.test(rel) || /^\/\.(env|launcher-keys)/.test(rel)
  if (blocked || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('Not found') }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  fs.createReadStream(file).pipe(res)
})

// ── Fake apps on 8747–8752 ──
function appPage(key, app) {
  const storageKey = `mock-${app.port}-session`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${app.name}</title>
<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f6f7fb;color:#141824}
header{background:#141824;color:#fff;padding:14px 18px;font-weight:600}main{padding:24px 18px;max-width:640px}
.ok{background:#e7f6ec;border:1px solid #a9dcb9;border-radius:12px;padding:16px}.no{background:#fff3e6;border:1px solid #f2c38b;border-radius:12px;padding:16px}
button{font:inherit;margin-top:12px;padding:8px 12px;border-radius:8px;border:1px solid #ccd;background:#fff;cursor:pointer}</style></head>
<body><header>${app.name} <small style="opacity:.6;font-weight:400">· mock app on port ${app.port}</small></header><main id="m">Loading…</main>
<script>
${app.kind === 'supabase' ? `
  const f = new URLSearchParams(location.hash.slice(1))
  if (f.get('access_token') && f.get('refresh_token')) {
    localStorage.setItem('${storageKey}', f.get('access_token'))
    history.replaceState(null, '', location.pathname)
  }
  const t = localStorage.getItem('${storageKey}')
  if (t) fetch('/whoami', { headers: { Authorization: 'Bearer ' + t } }).then(r => r.ok ? r.json() : null).then(render)
  else render(null)
  window.signOutHere = () => { localStorage.removeItem('${storageKey}'); render(null) }
` : `
  fetch('/api/me').then(r => r.ok ? r.json() : null).then(render)
  window.signOutHere = () => fetch('/api/logout', { method: 'POST' }).then(() => render(null))
`}
  function render(me) {
    document.getElementById('m').innerHTML = me
      ? '<div class="ok"><strong>Signed in as ' + me.email + '</strong>' + (me.role ? ' · role here: <b>' + me.role + '</b>' : '') + (me.created ? '<br>This account was created automatically on this first visit.' : '') + '<br>No password was asked: the launcher signed you in.<br><button onclick="signOutHere()">Sign out of this app</button></div>'
      : '<div class="no"><strong>Not signed in.</strong><br>This is where ${app.name}\\'s own login screen would be.</div>'
  }
</script></body></html>`
}

const seeded = Object.fromEntries(Object.entries(PROJECTS).map(([k, P]) => [k, new Set(P.profiles.map(p => p.email))]))
function fakeApp(key, app) {
  const env = { LAUNCHER_PUBLIC_KEY: KEYS.publicKey, LAUNCHER_URL: ORIGIN }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${app.port}`)
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${ORIGIN}`)
    if (url.pathname === '/api/launch') {
      if (app.kind === 'supabase') {
        return supabaseLaunch(req, res, { appName: app.name, audience: key, supabaseUrl: projectUrl(key), serviceKey: SERVICE_KEY, provision: app.provision, env })
      }
      const claims = receive(req, res, { appName: app.name, audience: key, env })
      if (!claims) return
      if (claims.role !== 'admin') return sendPage(res, 403, { title: 'Admins only', message: `${claims.sub} is not an admin in the launcher.`, launcherUrl: ORIGIN })
      res.setHeader('Set-Cookie', `mock_console=${encodeURIComponent(claims.sub)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
      return sendRedirect(res, '/')
    }
    if (url.pathname === '/whoami') {
      const u = userFromToken(key, req.headers.authorization)
      const prof = u && PROJECTS[key].profiles.find(p => p.id === u.id)
      return u ? json(res, 200, { email: u.email, role: prof && prof.role, created: !seeded[key].has(u.email) }) : json(res, 401, {})
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
    res.end(appPage(key, app))
  })
}

launcher.listen(PORT, () => {
  console.log(`Launcher mock running at ${ORIGIN}`)
  console.log('Sign-ins: super@ / admin@ / va@ / other@test.local (passwords at the top of tests/mock-server.mjs)')
})
for (const [key, app] of Object.entries(FAKE)) {
  fakeApp(key, app).listen(app.port, () => console.log(`  fake ${app.name} on http://localhost:${app.port}`))
}
