import assert from 'node:assert/strict'

export const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  LAUNCHER_SUPERADMIN_EMAILS: ' Owner@Offloadcrew.com ',
}

// Launcher roles stored on accounts (app_metadata.launcher_role).
export const ACCOUNT_ROLES = {
  'admin2@example.com': 'admin',
  'va@example.com': 'va',
  'second.va@example.com': 'va',
  'weird@example.com': 'superadmin', // can't be granted through an account
}

// Fake Supabase: a token of the form "tok:<email>" is valid for that email.
export const fakeFetch = async (url, opts) => {
  assert.ok(url.endsWith('/auth/v1/user'), `unexpected url ${url}`)
  assert.equal(opts.headers.apikey, ENV.SUPABASE_ANON_KEY)
  const m = /^Bearer tok:(.+)$/.exec(opts.headers.Authorization || '')
  if (!m) return { ok: false, status: 401, json: async () => ({ msg: 'invalid JWT' }) }
  const role = ACCOUNT_ROLES[m[1].toLowerCase()]
  return {
    ok: true, status: 200,
    json: async () => ({ id: 'id-' + m[1], email: m[1], user_metadata: { full_name: 'Name ' + m[1] }, app_metadata: role ? { launcher_role: role } : {} }),
  }
}

export function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {}, ended: false, text: '',
    setHeader(k, v) { this.headers[k] = v },
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    end(t) { this.ended = true; if (t) this.text = t; return this },
  }
}
