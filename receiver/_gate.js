// Offload Crew Launcher — staging gate.
//
// Locks a test (preview) deployment to launcher admins, with no Vercel login:
//
//   1. An admin opens the staging app from the launcher. The app's
//      /api/launch route verifies the launch ticket (see _launcher.js), and on
//      a preview deployment calls setGateCookie(): a signed, HttpOnly cookie
//      that says "a launcher admin came through here", valid 12 hours.
//   2. middleware.js runs stagingGate() in front of EVERY request on preview
//      deployments. No valid cookie → a page that says "open this from the
//      launcher" (or a 403 for API calls). Production is never gated.
//
// Every gated app carries an IDENTICAL copy of this file as api/_gate.js. The
// canonical copy lives in the internal-launcher repo under receiver/, with
// its tests; change it there and copy it out.
//
// Needs LAUNCHER_GATE_SECRET (Preview environment) on each gated project.
// No dependencies; Web Crypto, so it runs in middleware and functions alike.

export const GATE_COOKIE = 'offload_gate'
export const GATE_TTL_S = 12 * 60 * 60
const DEFAULT_LAUNCHER_URL = 'https://internal-launcher.vercel.app'

const enc = new TextEncoder()

function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function fromB64url(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Only preview deployments are gated. Production and local development never.
export function gateEnabled(env = process.env) {
  return env.VERCEL_ENV === 'preview'
}

export async function makeGateCookie(email, secret, { now = Date.now(), ttl = GATE_TTL_S } = {}) {
  const head = `v1.${b64url(enc.encode(String(email).toLowerCase()))}.${Math.floor(now / 1000) + ttl}`
  return `${head}.${b64url(await hmac(secret, head))}`
}

// The email the cookie was issued to, or null if it is missing, forged or expired.
export async function readGateCookie(value, secret, { now = Date.now() } = {}) {
  try {
    const parts = String(value || '').split('.')
    if (parts.length !== 4 || parts[0] !== 'v1' || !secret) return null
    const head = parts.slice(0, 3).join('.')
    if (!sameBytes(fromB64url(parts[3]), await hmac(secret, head))) return null
    if (!(Number(parts[2]) > Math.floor(now / 1000))) return null
    return new TextDecoder().decode(fromB64url(parts[1]))
  } catch {
    return null
  }
}

export function cookieValue(cookieHeader, name = GATE_COOKIE) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export function gateSetCookie(value, ttl = GATE_TTL_S) {
  return `${GATE_COOKIE}=${value}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`
}

// For /api/launch on a preview deployment: add the gate cookie to the response,
// keeping any cookie the route has already set (e.g. the console session).
export async function setGateCookie(res, email, { env = process.env, now = Date.now() } = {}) {
  const secret = env.LAUNCHER_GATE_SECRET
  if (!secret) return false
  const cookie = gateSetCookie(await makeGateCookie(email, secret, { now }))
  const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined
  res.setHeader('Set-Cookie', [].concat(existing || [], cookie))
  return true
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function blockedPage(appName, openUrl, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(appName)} · locked</title>
<style>:root{color-scheme:light dark;--bg:#f6f7fb;--fg:#141824;--muted:#5b6275;--card:#fff;--line:#e3e6ee;--btn:#141824;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--fg:#eef1f8;--muted:#9aa3b8;--card:#141a2e;--line:#232b45;--btn:#fff;--btnfg:#0b1020}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;padding:16px;box-sizing:border-box}
.card{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:17px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}
a.btn{display:inline-block;background:var(--btn);color:var(--btnfg);text-decoration:none;font-weight:600;padding:10px 16px;border-radius:10px}</style></head>
<body><div class="card"><h1>${esc(appName)} is for Offload Crew admins</h1><p>${esc(message)}</p><a class="btn" href="${esc(openUrl)}">Open through the launcher</a></div></body></html>`
}

// The middleware. `allow` lists extra paths that must stay reachable without
// the cookie (server-to-server callbacks such as a payment webhook).
export function stagingGate({ appName, appKey, allow = [] } = {}) {
  return async function gate(request) {
    const env = process.env
    if (!gateEnabled(env)) return undefined // production / local: untouched

    const url = new URL(request.url)
    if (url.pathname === '/api/launch' || allow.some(re => re.test(url.pathname))) return undefined

    const launcher = (env.LAUNCHER_URL || DEFAULT_LAUNCHER_URL).replace(/\/+$/, '')
    const openUrl = `${launcher}/?open=${encodeURIComponent(appKey)}&origin=${encodeURIComponent(url.origin)}`
    const deny = (status, message) => {
      const wantsHtml = request.method === 'GET' && /text\/html/.test(request.headers.get('accept') || '')
      return wantsHtml
        ? new Response(blockedPage(appName, openUrl, message), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } })
        : Response.json({ error: message, open: openUrl }, { status, headers: { 'cache-control': 'no-store' } })
    }

    try {
      const secret = env.LAUNCHER_GATE_SECRET
      if (!secret) return deny(503, 'This test site is locked, and its lock is not set up yet (LAUNCHER_GATE_SECRET).')
      const who = await readGateCookie(cookieValue(request.headers.get('cookie')), secret)
      if (who) return undefined
      return deny(403, 'Sign in to the Offload Crew Launcher as an admin, then open it from there. No other login is needed.')
    } catch (err) {
      console.error('[gate]', err && err.message)
      return deny(500, 'Something went wrong checking your access. Open it from the launcher again.')
    }
  }
}
