import assert from 'node:assert/strict'

export const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  LAUNCHER_ADMIN_EMAILS: 'Owner@Offloadcrew.com',
  LAUNCHER_VA_EMAILS: ' va@example.com , second.va@example.com ',
}

// Fake Supabase: a token of the form "tok:<email>" is valid for that email.
export const fakeFetch = async (url, opts) => {
  assert.ok(url.endsWith('/auth/v1/user'), `unexpected url ${url}`)
  assert.equal(opts.headers.apikey, ENV.SUPABASE_ANON_KEY)
  const m = /^Bearer tok:(.+)$/.exec(opts.headers.Authorization || '')
  if (!m) return { ok: false, status: 401, json: async () => ({ msg: 'invalid JWT' }) }
  return { ok: true, status: 200, json: async () => ({ id: 'id-' + m[1], email: m[1] }) }
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
