// Local stand-in for Vercel + Supabase Auth, so the launcher can be tried end
// to end with no real project and no credentials:
//
//   npm run dev:mock      → http://localhost:8746
//
// It serves the static files, mounts the real /api/* handlers, and fakes just
// enough of Supabase Auth (password sign-in, refresh, /user, logout) for them
// to work. Three throwaway accounts exist only in this process:
//
//   admin@test.local   password: admin-pass-local   → every tile
//   va@test.local      password: va-pass-local      → VA tiles only
//   other@test.local   password: other-pass-local   → signs in, then refused
//
// Nothing here is reachable from a deployed launcher; Vercel ignores tests/.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 8746)
const ORIGIN = `http://localhost:${PORT}`

process.env.SUPABASE_URL = ORIGIN
process.env.SUPABASE_ANON_KEY = 'mock-anon-key'
process.env.LAUNCHER_ADMIN_EMAILS = 'admin@test.local'
process.env.LAUNCHER_VA_EMAILS = 'va@test.local'
// LAUNCHER_USE_CUSTOM_DOMAINS is left to the shell, e.g.
//   LAUNCHER_USE_CUSTOM_DOMAINS=1 npm run dev:mock

const USERS = {
  'admin@test.local': 'admin-pass-local',
  'va@test.local': 'va-pass-local',
  'other@test.local': 'other-pass-local',
}

// Imported after the env is set, since _apps.js reads it per request anyway
// and apps.js reads it per request too; this just keeps the order obvious.
const appsHandler = (await import('../api/apps.js')).default
const configHandler = (await import('../api/config.js')).default

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// Give Node's ServerResponse the two helpers Vercel adds.
function vercelRes(res) {
  res.status = c => { res.statusCode = c; return res }
  res.json = b => json(res, res.statusCode || 200, b)
  return res
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

function tokensFor(email) {
  return {
    access_token: 'access-' + email,
    refresh_token: 'refresh-' + email,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'id-' + email, email },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN)
  const p = url.pathname

  // The real launcher API.
  if (p === '/api/apps') return appsHandler(req, vercelRes(res))
  if (p === '/api/config') return configHandler(req, vercelRes(res))

  // Fake Supabase Auth.
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const body = await readJson(req)
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const email = String(body.email || '').toLowerCase()
      if (USERS[email] && USERS[email] === body.password) return json(res, 200, tokensFor(email))
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
    if (m && USERS[m[1]]) return json(res, 200, { id: 'id-' + m[1], email: m[1], aud: 'authenticated' })
    return json(res, 401, { code: 401, msg: 'invalid JWT' })
  }
  if (p === '/auth/v1/logout') { res.statusCode = 204; return res.end() }

  // Static files from the repo root, minus anything that is not a page asset.
  const rel = p === '/' ? '/index.html' : decodeURIComponent(p)
  const file = path.join(ROOT, path.normalize(rel))
  const blocked = !file.startsWith(ROOT + path.sep) || /^\/(api|tests|node_modules|\.git|\.claude)(\/|$)/.test(rel) || /^\/\.env/.test(rel)
  if (blocked || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404
    return res.end('Not found')
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  fs.createReadStream(file).pipe(res)
})

server.listen(PORT, () => {
  console.log(`Launcher mock running at ${ORIGIN}`)
  console.log('Accounts: admin@test.local / va@test.local / other@test.local (passwords in tests/mock-server.mjs)')
})
