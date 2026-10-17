// Offload Crew Launcher — sign-in receiver.
//
// Every app the launcher opens carries an IDENTICAL copy of this file as
// api/_launcher.js (api/_launcher.mjs in Crew Training). The canonical copy
// lives in the internal-launcher repo under receiver/, with its tests; change
// it there and copy it out, never edit a copy in place.
//
// How single sign-on works:
//   1. Someone signs in to the launcher once.
//   2. Opening an app asks the launcher for a launch ticket: a 60-second pass
//      naming who they are, their launcher role, and which app it is for,
//      signed with the launcher's private key (Ed25519).
//   3. The app's /api/launch?ticket=… route verifies it with the launcher's
//      PUBLIC key (LAUNCHER_PUBLIC_KEY), then signs the person in with the
//      app's own login system and redirects into the app.
//   4. Apps that opt in (`provision`) create the person's account on their
//      first visit, with a role taken from the launcher role. Apps that don't
//      opt in refuse anyone without an account, as before.
//
// No dependencies; Node 18+ (global fetch, node:crypto Ed25519).

import crypto from 'node:crypto'

export const TICKET_PREFIX = 'v1'
export const TICKET_ISSUER = 'offload-crew-launcher'
const CLOCK_SKEW_S = 30
const MAX_TTL_S = 300

// ── Ticket verification ──────────────────────────────────────────────────

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

let cachedKey = { raw: null, key: null }
function publicKeyFrom(raw) {
  if (cachedKey.raw === raw) return cachedKey.key
  const key = crypto.createPublicKey({ key: Buffer.from(String(raw).trim(), 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('LAUNCHER_PUBLIC_KEY is not an Ed25519 key')
  cachedKey = { raw, key }
  return key
}

// Resolves to { ok: true, claims } or { ok: false, reason }. `audience` is
// the app key this deployment answers to (string or array of strings).
export function verifyTicket(token, { publicKey, audience, now = Date.now() } = {}) {
  if (!publicKey) return { ok: false, reason: 'not-configured' }
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return { ok: false, reason: 'malformed' }

  let key
  try { key = publicKeyFrom(publicKey) } catch { return { ok: false, reason: 'not-configured' } }

  let valid = false
  try {
    valid = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]))
  } catch { valid = false }
  if (!valid) return { ok: false, reason: 'bad-signature' }

  let claims
  try { claims = JSON.parse(fromB64url(parts[1]).toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' }

  const nowS = Math.floor(now / 1000)
  const audiences = [].concat(audience || [])
  if (claims.iss !== TICKET_ISSUER) return { ok: false, reason: 'wrong-issuer' }
  if (!audiences.includes(claims.aud)) return { ok: false, reason: 'wrong-app' }
  if (typeof claims.sub !== 'string' || !claims.sub.includes('@')) return { ok: false, reason: 'malformed' }
  if (claims.role !== 'admin' && claims.role !== 'va') return { ok: false, reason: 'malformed' }
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) return { ok: false, reason: 'malformed' }
  if (claims.iat > nowS + CLOCK_SKEW_S) return { ok: false, reason: 'not-yet-valid' }
  if (claims.exp - claims.iat > MAX_TTL_S) return { ok: false, reason: 'malformed' }
  if (claims.exp < nowS - CLOCK_SKEW_S) return { ok: false, reason: 'expired' }

  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 120) : ''
  return { ok: true, claims: { ...claims, sub: claims.sub.trim().toLowerCase(), name: name || null } }
}

// Production deployments answer to `production`, everything else (the
// staging branch, previews) to `other`. LAUNCHER_APP_KEY overrides both.
export function audienceFor({ production, other }, env = process.env) {
  if (env.LAUNCHER_APP_KEY) return env.LAUNCHER_APP_KEY
  return env.VERCEL_ENV === 'production' ? production : (other || production)
}

// ── Responses ────────────────────────────────────────────────────────────

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Robots-Tag', 'noindex')
}

// A small self-contained page; it shows inside the launcher's app window, so
// it stays neutral and readable in light and dark.
export function sendPage(res, status, { title, message, launcherUrl, continueUrl, continueLabel } = {}) {
  baseHeaders(res)
  const home = launcherUrl || process.env.LAUNCHER_URL || 'https://apps.offloadcrew.com'
  const links = [
    continueUrl ? `<a href="${esc(continueUrl)}">${esc(continueLabel || 'Continue to sign in')}</a>` : '',
    `<a href="${esc(home)}" target="_top">Back to the launcher</a>`,
  ].filter(Boolean).join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:#f6f7fb;--fg:#141824;--muted:#5b6275;--card:#fff;--line:#e3e6ee;--link:#2453d4}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--fg:#eef1f8;--muted:#9aa3b8;--card:#141a2e;--line:#232b45;--link:#8fb0ff}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;padding:16px;box-sizing:border-box}
.card{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:17px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}a{color:var(--link);display:block;margin-top:8px}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p>${links}</div></body></html>`
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
}

export function sendRedirect(res, location) {
  baseHeaders(res)
  res.statusCode = 302
  res.setHeader('Location', location)
  res.end()
}

// Hands a Supabase session to the app the same way Supabase's own magic links
// do: in the URL fragment, which never reaches a server or a log. supabase-js
// (detectSessionInUrl, the default) picks it up, stores it and clears the URL.
export function sendSessionRedirect(res, session, path = '/') {
  const f = new URLSearchParams({
    access_token: session.access_token,
    expires_at: String(session.expires_at || Math.floor(Date.now() / 1000) + (Number(session.expires_in) || 3600)),
    expires_in: String(session.expires_in || 3600),
    refresh_token: session.refresh_token,
    token_type: session.token_type || 'bearer',
    type: 'magiclink',
  })
  sendRedirect(res, `${path}#${f.toString()}`)
}

const REASON_TEXT = {
  'expired': 'This sign-in link has expired. Open the app again from the launcher.',
  'not-yet-valid': 'This sign-in link is not valid yet. Check your computer clock, then open the app again from the launcher.',
  'wrong-app': 'This sign-in link was made for a different app. Open the app again from the launcher.',
  'bad-signature': 'This sign-in link is not valid. Open the app again from the launcher.',
  'malformed': 'This sign-in link is not valid. Open the app again from the launcher.',
  'wrong-issuer': 'This sign-in link is not valid. Open the app again from the launcher.',
  'missing': 'Open this app from the Offload Crew Launcher to sign in automatically.',
}

// Reads and verifies ?ticket=…. Returns the claims, or sends an explanatory
// page and returns null so callers can just `if (!claims) return`.
export function receive(req, res, { appName, audience, env = process.env, now = Date.now() } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET')
    sendPage(res, 405, { title: 'Not allowed', message: 'Open this app from the Offload Crew Launcher.' })
    return null
  }
  const continueUrl = '/'
  if (!env.LAUNCHER_PUBLIC_KEY) {
    sendPage(res, 503, { title: `${appName}: launcher sign-in is not set up yet`, message: 'Sign in with your usual email and password for now.', continueUrl })
    return null
  }
  const ticket = new URL(req.url || '/', 'http://local').searchParams.get('ticket')
  if (!ticket) {
    sendPage(res, 400, { title: appName, message: REASON_TEXT.missing, continueUrl })
    return null
  }
  const result = verifyTicket(ticket, { publicKey: env.LAUNCHER_PUBLIC_KEY, audience, now })
  if (!result.ok) {
    if (result.reason === 'not-configured') {
      sendPage(res, 503, { title: `${appName}: launcher sign-in is misconfigured`, message: 'The launcher key on this app is not valid. Sign in with your usual email and password for now.', continueUrl })
    } else {
      sendPage(res, 401, { title: `Could not sign you in to ${appName}`, message: REASON_TEXT[result.reason] || REASON_TEXT.malformed, continueUrl })
    }
    return null
  }
  return result.claims
}

// ── Supabase (REST, no SDK) ──────────────────────────────────────────────

function adminHeaders(serviceKey) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }
}

async function readJson(r) {
  const text = await r.text()
  try { return text ? JSON.parse(text) : null } catch { return null }
}

// The app's own profile row for this email, or null. Apps keep authority over
// who may use them: no profile, no sign-in, and nothing is ever created here.
export async function findProfileByEmail({ url, serviceKey, email, select = 'id,email', fetchFn = fetch }) {
  const q = new URLSearchParams({ select, email: `eq.${String(email).trim().toLowerCase()}`, limit: '2' })
  const r = await fetchFn(`${url.replace(/\/+$/, '')}/rest/v1/profiles?${q}`, { headers: adminHeaders(serviceKey) })
  if (!r.ok) throw new Error(`profile lookup failed (${r.status})`)
  const rows = await readJson(r)
  if (!Array.isArray(rows) || rows.length !== 1) return null
  return rows[0]
}

// Calls a Postgres function. Resolves to { exists: false } when the database
// does not have it (older schema), otherwise { exists: true, value }.
export async function callRpc({ url, serviceKey, fn, args = {}, fetchFn = fetch }) {
  const r = await fetchFn(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: adminHeaders(serviceKey), body: JSON.stringify(args),
  })
  if (r.status === 404) return { exists: false }
  const body = await readJson(r)
  if (!r.ok) {
    if (body && body.code === 'PGRST202') return { exists: false }
    throw new Error(`${fn} failed (${r.status})`)
  }
  return { exists: true, value: body }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Makes a login for someone the launcher vouched for, on their first visit to
// an app that opts in. No password is set: they come in through the launcher.
// The app's own sign-up trigger creates the profile; this waits for it, then
// sets the role. Resolves to the profile row.
export async function provisionAccount({ url, serviceKey, email, name, role, fetchFn = fetch, wait = sleep }) {
  const base = url.replace(/\/+$/, '')
  const r = await fetchFn(`${base}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders(serviceKey),
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: name || email.split('@')[0] } }),
  })
  const user = await readJson(r)
  if (!r.ok || !user || !user.id) {
    throw new Error(r.status === 422 ? 'a login exists for this email but has no profile' : `create user failed (${r.status})`)
  }
  let profile = null
  for (let i = 0; i < 8 && !profile; i++) {
    profile = await findProfileByEmail({ url, serviceKey, email, select: 'id,email,role', fetchFn })
    if (!profile) await wait(250)
  }
  if (!profile) throw new Error('the app did not create a profile for the new login')
  if (profile.id !== user.id) throw new Error('account mismatch')
  if (role && profile.role !== role) {
    const p = await fetchFn(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}`, {
      method: 'PATCH', headers: { ...adminHeaders(serviceKey), Prefer: 'return=minimal' }, body: JSON.stringify({ role }),
    })
    if (!p.ok) throw new Error(`could not set the new profile's role (${p.status})`)
  }
  return profile
}

// Creates a fresh session for an EXISTING user without their password:
// generate a magic link server-side (no email is sent) and redeem it
// immediately. Refuses if Supabase would have created a new account.
export async function mintSession({ url, serviceKey, email, expectUserId, fetchFn = fetch }) {
  const base = url.replace(/\/+$/, '')
  const r = await fetchFn(`${base}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: adminHeaders(serviceKey), body: JSON.stringify({ type: 'magiclink', email }),
  })
  const link = await readJson(r)
  if (!r.ok || !link) throw new Error(`generate_link failed (${r.status})`)
  const hashed = link.hashed_token || link.properties?.hashed_token
  const userId = link.id || link.user?.id
  const kind = link.verification_type || link.properties?.verification_type
  if (!hashed) throw new Error('generate_link returned no token')
  if (kind && kind !== 'magiclink') throw new Error(`generate_link returned a ${kind} link`)
  if (expectUserId && userId && userId !== expectUserId) throw new Error('account mismatch')

  for (const type of ['magiclink', 'email']) {
    const v = await fetchFn(`${base}/auth/v1/verify`, {
      method: 'POST', headers: adminHeaders(serviceKey), body: JSON.stringify({ type, token_hash: hashed }),
    })
    const session = await readJson(v)
    if (v.ok && session && session.access_token && session.refresh_token) return session
    if (v.status !== 400 && v.status !== 422) throw new Error(`verify failed (${v.status})`)
  }
  throw new Error('verify rejected the link')
}

// The whole flow for a Supabase app: verify the ticket, find the profile (or
// create it, if the app opts in), run the app's own extra check, mint a
// session, redirect into the app.
//   check(profile)  → null to allow, or { title, message } to refuse.
//   provision       → { admin: '<app role>', va: '<app role>' } to create
//                     missing accounts with that role; omit to refuse instead.
export async function supabaseLaunch(req, res, {
  appName, audience, supabaseUrl, serviceKey, select = 'id,email', check, provision, path = '/',
  env = process.env, fetchFn = fetch, now = Date.now(), wait,
} = {}) {
  const claims = receive(req, res, { appName, audience, env, now })
  if (!claims) return
  if (!supabaseUrl || !serviceKey) {
    return sendPage(res, 503, {
      title: `${appName}: launcher sign-in is not set up yet`,
      message: 'This app needs its Supabase service key in Vercel. Sign in with your usual email and password for now.',
      continueUrl: '/',
    })
  }
  try {
    let profile = await findProfileByEmail({ url: supabaseUrl, serviceKey, email: claims.sub, select, fetchFn })
    if (!profile && provision && provision[claims.role]) {
      await provisionAccount({ url: supabaseUrl, serviceKey, email: claims.sub, name: claims.name, role: provision[claims.role], fetchFn, ...(wait ? { wait } : {}) })
      profile = await findProfileByEmail({ url: supabaseUrl, serviceKey, email: claims.sub, select, fetchFn })
    }
    if (!profile) {
      return sendPage(res, 403, {
        title: `No ${appName} account for ${claims.sub}`,
        message: `Ask an admin to add ${claims.sub} to ${appName}, using the same email as the launcher.`,
      })
    }
    const refusal = check ? await check(profile, { claims, supabaseUrl, serviceKey, fetchFn }) : null
    if (refusal) return sendPage(res, 403, refusal)
    const session = await mintSession({ url: supabaseUrl, serviceKey, email: profile.email || claims.sub, expectUserId: profile.id, fetchFn })
    return sendSessionRedirect(res, session, path)
  } catch (err) {
    console.error(`[launch] ${appName}:`, err && err.message)
    return sendPage(res, 502, {
      title: `Could not sign you in to ${appName}`,
      message: 'Something went wrong on our side. Try again in a moment, or sign in with your email and password.',
      continueUrl: '/',
    })
  }
}
