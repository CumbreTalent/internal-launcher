// Browser-side session for the launcher. Plain script, no SDK, no build step.
//
// Signs in against Supabase Auth's REST API using the public settings from
// /api/config, keeps the tokens in localStorage, refreshes them when they are
// about to expire, and asks /api/apps which tiles this person may open.
//
// Exposes window.LauncherAuth = { signIn, signOut, session, apps, clear }.

(function () {
  const KEY = 'offload-launcher-session'
  let configPromise = null

  function config() {
    if (!configPromise) {
      configPromise = fetch('/api/config', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('config'))))
        .catch(() => { configPromise = null; throw new Error('Could not reach the launcher server. Check your connection and try again.') })
    }
    return configPromise
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null')
      return s && s.access_token && s.refresh_token ? s : null
    } catch (e) { return null }
  }

  function save(s) {
    const expiresAt = s.expires_at || Math.floor(Date.now() / 1000) + (Number(s.expires_in) || 3600)
    try {
      localStorage.setItem(KEY, JSON.stringify({
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: expiresAt,
      }))
    } catch (e) {}
  }

  function clear() {
    try { localStorage.removeItem(KEY) } catch (e) {}
  }

  function friendly(msg) {
    const m = String(msg || '')
    if (/invalid login credentials|invalid_credentials/i.test(m)) return 'Wrong email or password.'
    if (/email not confirmed/i.test(m)) return 'This email has not been confirmed yet.'
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.'
    return m || 'Sign-in failed.'
  }

  async function authPost(path, body) {
    const c = await config()
    let r
    try {
      r = await fetch(c.supabaseUrl + path, {
        method: 'POST',
        headers: { apikey: c.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new Error('Could not reach the sign-in service. Check your connection and try again.')
    }
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(friendly(data.error_description || data.msg || data.message || data.error))
    return data
  }

  async function signIn(email, password) {
    const s = await authPost('/auth/v1/token?grant_type=password', { email: email, password: password })
    if (!s.access_token || !s.refresh_token) throw new Error('Sign-in failed.')
    save(s)
    return load()
  }

  // Trades the refresh token for a new pair. Returns the new session, or null
  // (and clears storage) when Supabase rejects it.
  async function refresh(s) {
    try {
      const n = await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      if (!n.access_token || !n.refresh_token) throw new Error('refresh')
      save(n)
      return load()
    } catch (e) {
      clear()
      return null
    }
  }

  // The current session, refreshed first if it expires within a minute.
  async function session() {
    const s = load()
    if (!s) return null
    const now = Math.floor(Date.now() / 1000)
    if (!s.expires_at || s.expires_at - now < 60) return refresh(s)
    return s
  }

  async function signOut() {
    const s = load()
    clear()
    if (!s) return
    try {
      const c = await config()
      await fetch(c.supabaseUrl + '/auth/v1/logout', {
        method: 'POST',
        headers: { apikey: c.supabaseAnonKey, Authorization: 'Bearer ' + s.access_token },
      })
    } catch (e) {}
  }

  async function fetchApps(token) {
    const r = await fetch('/api/apps', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
    const data = await r.json().catch(() => null)
    return { status: r.status, data: data }
  }

  // Resolves to { status, data }. 401 with no network call when nobody is
  // signed in; otherwise whatever /api/apps answered, after one refresh
  // attempt if the first answer was 401.
  async function apps() {
    let s = await session()
    if (!s) return { status: 401, data: null }
    let out = await fetchApps(s.access_token)
    if (out.status === 401) {
      s = await refresh(s)
      if (!s) return { status: 401, data: null }
      out = await fetchApps(s.access_token)
      if (out.status === 401) clear()
    }
    return out
  }

  async function postLaunch(token, app) {
    const r = await fetch('/api/launch', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: app }),
      cache: 'no-store',
    })
    const data = await r.json().catch(() => null)
    return { status: r.status, data: data }
  }

  // The address to open for one app: { status, data: { url, sso } }. Same
  // refresh-once-on-401 behaviour as apps().
  async function launch(app) {
    let s = await session()
    if (!s) return { status: 401, data: null }
    let out = await postLaunch(s.access_token, app)
    if (out.status === 401) {
      s = await refresh(s)
      if (!s) return { status: 401, data: null }
      out = await postLaunch(s.access_token, app)
      if (out.status === 401) clear()
    }
    return out
  }

  window.LauncherAuth = { signIn: signIn, signOut: signOut, session: session, apps: apps, launch: launch, clear: clear }
})()
