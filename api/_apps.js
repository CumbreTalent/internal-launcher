// Tile list and role rules for the Offload Crew Launcher.
//
// Server-side only: the underscore prefix keeps Vercel from deploying it as a
// route. A browser only ever receives the tiles its role may open, so the
// staging and console addresses never reach a virtual assistant.

// Each tile:
//   key     — stable id; also the app name inside launch tickets
//   legacy  — where the app lives today (*.vercel.app)
//   custom  — where it lives once the offloadcrew.com subdomains are added
//             (flip LAUNCHER_USE_CUSTOM_DOMAINS=1 to switch every tile)
//   url     — instead of legacy/custom, for pages inside the launcher itself
//   sso     — the app has the /api/launch receiver, so opening it from the
//             launcher signs the person in automatically
//   embed   — open inside the launcher window. Only happens when the app and
//             the launcher share a domain (offloadcrew.com); otherwise the app
//             opens in a new tab. Staging stays in a new tab because Vercel's
//             own sign-in page refuses to load inside another page.
//   previewHosts   — for staging tiles: the other test addresses of the same app
//             (every Vercel preview build, and the future offloadcrew.com
//             staging address). The staging lock sends admins back to the
//             exact one they came from, so tickets may only go to these.
//   adminOnly      — admins and the super admin only (hidden from assistants)
//   superadminOnly — the super admin only
//   badge          — little yellow tag
//   hidden  — kept in the list but shown to nobody, admins included, and
//             cannot be launched (for an app that is temporarily broken)
export const APPS = [
  {
    key: 'quotes',
    label: 'Quote Builder',
    icon: 'ti-file-invoice',
    color: 'linear-gradient(160deg, #e8651a, #b23b1a)',
    legacy: 'https://offload-quote-builder.vercel.app',
    custom: 'https://quotes.offloadcrew.com',
    sso: true,
    embed: true,
  },
  {
    key: 'quotes-staging',
    label: 'QB Staging',
    icon: 'ti-flask',
    color: 'linear-gradient(160deg, #d4a017, #8a6d0f)',
    badge: 'TEST',
    adminOnly: true,
    legacy: 'https://offload-quote-builder-git-staging-cumbretalent-5400s-projects.vercel.app',
    custom: 'https://quotes-staging.offloadcrew.com',
    previewHosts: [/^offload-quote-builder-[a-z0-9-]+-cumbretalent-5400s-projects\.vercel\.app$/, /^quotes-staging\.offloadcrew\.com$/],
    sso: true,
    embed: false,
  },
  {
    key: 'console',
    label: 'Admin Console',
    icon: 'ti-shield-lock',
    color: 'linear-gradient(160deg, #2dd4bf, #0f766e)',
    adminOnly: true,
    // Hidden until the live console is configured: its Vercel Production env
    // has no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, so every API call fails.
    // Use Admin Staging meanwhile. Delete this line to bring the tile back.
    hidden: true,
    legacy: 'https://tradezip-admin.vercel.app',
    custom: 'https://console.offloadcrew.com',
    sso: true,
    embed: true,
  },
  {
    key: 'console-staging',
    label: 'Admin Staging',
    icon: 'ti-shield-lock',
    color: 'linear-gradient(160deg, #d4a017, #8a6d0f)',
    badge: 'TEST',
    adminOnly: true,
    legacy: 'https://tradezip-admin-git-staging-cumbretalent-5400s-projects.vercel.app',
    custom: 'https://console-staging.offloadcrew.com',
    previewHosts: [/^tradezip-admin-[a-z0-9-]+-cumbretalent-5400s-projects\.vercel\.app$/, /^console-staging\.offloadcrew\.com$/],
    sso: true,
    embed: false,
  },
  {
    key: 'training',
    label: 'Crew Training',
    icon: 'ti-user-plus',
    color: 'linear-gradient(160deg, #3a9d5d, #1a7a3c)',
    legacy: 'https://offload-crew-training.vercel.app',
    custom: 'https://training.offloadcrew.com',
    sso: true,
    embed: true,
  },
  {
    key: 'invoices',
    label: 'Invoice Chaser',
    icon: 'ti-cash-banknote',
    color: 'linear-gradient(160deg, #60a5fa, #2563eb)',
    legacy: 'https://invoice-chaser-silk.vercel.app',
    custom: 'https://invoices.offloadcrew.com',
    sso: true,
    embed: true,
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: 'ti-route',
    color: 'linear-gradient(160deg, #9b6fd4, #5b3aa8)',
    url: '/workflow.html',
    sso: false,
    embed: true,
  },
  {
    // Inside the launcher: add people, set their role, remove access.
    key: 'people',
    label: 'People',
    icon: 'ti-users',
    color: 'linear-gradient(160deg, #64748b, #334155)',
    url: '/people.html',
    superadminOnly: true,
    sso: false,
    embed: true,
  },
  // Add more tiles by copying a block above. Mark anything an assistant must
  // not see with `adminOnly: true`, and super-admin-only tools with
  // `superadminOnly: true`.
]

// Three roles:
//   superadmin — set ONLY by LAUNCHER_SUPERADMIN_EMAILS in Vercel, so no screen
//                can create one. Sees everything, including People.
//   admin      — every tool except People.
//   va         — virtual assistant: the everyday tools only.
// Admins and assistants are stored on their Quote Builder login, in Supabase
// app_metadata.launcher_role, which only the server (service key) can write.
// The People screen manages it. Anyone else who signs in is refused, which
// matters because the Quote Builder's Supabase also holds customer accounts.
export const ROLES = ['superadmin', 'admin', 'va']
export const ASSIGNABLE_ROLES = ['admin', 'va']
export const ROLE_LABEL = { superadmin: 'Super admin', admin: 'Admin', va: 'Assistant' }

export function parseList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

export const normEmail = e => String(e || '').trim().toLowerCase()

export function isSuperadminEmail(email, env = process.env) {
  const e = normEmail(email)
  return !!e && parseList(env.LAUNCHER_SUPERADMIN_EMAILS).includes(e)
}

// user: { email, appMetadata } as returned by verifyUser / the admin API.
export function roleFor(user, env = process.env) {
  if (!user || !normEmail(user.email)) return null
  if (isSuperadminEmail(user.email, env)) return 'superadmin'
  const r = user.appMetadata && user.appMetadata.launcher_role
  return ASSIGNABLE_ROLES.includes(r) ? r : null
}

export const isAdminLevel = role => role === 'superadmin' || role === 'admin'

// Apps only know admin and assistant: a super admin opens them as an admin.
export const ticketRole = role => (isAdminLevel(role) ? 'admin' : role)

export function useCustomDomains(env = process.env) {
  return env.LAUNCHER_USE_CUSTOM_DOMAINS === '1'
}

// A test address this app's staging tile may send a ticket to, or null.
export function previewOrigin(app, origin) {
  if (!app || !app.previewHosts || typeof origin !== 'string') return null
  let u
  try { u = new URL(origin) } catch { return null }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null
  return app.previewHosts.some(re => re.test(u.hostname)) ? u.origin : null
}

export function tileUrl(app, custom) {
  if (app.url) return app.url
  return custom ? app.custom : app.legacy
}

export function allowed(app, role) {
  if (app.hidden || !ROLES.includes(role)) return false
  if (app.superadminOnly) return role === 'superadmin'
  if (app.adminOnly) return isAdminLevel(role)
  return true
}

// The app with this key, if this role may open it; null otherwise (an unknown
// key and a forbidden one look the same to the caller).
export function appFor(key, role) {
  const app = APPS.find(a => a.key === key)
  return app && allowed(app, role) ? app : null
}

// The tiles a role may open, in display order, with only the fields the
// browser needs to draw them.
export function tilesFor(role, env = process.env) {
  if (!ROLES.includes(role)) return []
  const custom = useCustomDomains(env)
  return APPS
    .filter(a => allowed(a, role))
    .map(a => ({
      key: a.key,
      label: a.label,
      url: tileUrl(a, custom),
      icon: a.icon,
      color: a.color,
      badge: a.badge || null,
      embed: a.embed !== false,
    }))
}
