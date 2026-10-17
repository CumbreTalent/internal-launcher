// Tile list and role rules for the launcher.
//
// This file is server-side only: the underscore prefix keeps Vercel from
// deploying it as a route, and /api/apps.js is the only thing that reads it.
// A browser therefore only ever receives the tiles its role may open; the
// staging and console addresses never ship to a virtual assistant.

// Each tile has two addresses:
//   legacy — where the app lives today (Vercel's *.vercel.app hostnames)
//   custom — where it will live once the offloadcrew.com subdomains are added
//            in Vercel and DNS (see README, "Put it on offloadcrew.com")
// Set LAUNCHER_USE_CUSTOM_DOMAINS=1 in the launcher's Vercel environment to
// switch every tile at once. No code change needed.
export const APPS = [
  {
    key: 'quotes',
    label: 'Quote Builder',
    icon: 'ti-file-invoice',
    color: 'linear-gradient(160deg, #e8651a, #b23b1a)',
    legacy: 'https://rqr-quote-builder.vercel.app',
    custom: 'https://quotes.offloadcrew.com',
  },
  {
    key: 'quotes-staging',
    label: 'QB Staging',
    icon: 'ti-flask',
    color: 'linear-gradient(160deg, #d4a017, #8a6d0f)',
    badge: 'TEST',
    adminOnly: true,
    legacy: 'https://rqr-quote-builder-git-staging-cumbretalent-5400s-projects.vercel.app',
    custom: 'https://quotes-staging.offloadcrew.com',
  },
  {
    key: 'console',
    label: 'Admin Console',
    icon: 'ti-shield-lock',
    color: 'linear-gradient(160deg, #2dd4bf, #0f766e)',
    adminOnly: true,
    legacy: 'https://tradezip-admin.vercel.app',
    custom: 'https://console.offloadcrew.com',
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
  },
  {
    key: 'training',
    label: 'Crew Training',
    icon: 'ti-user-plus',
    color: 'linear-gradient(160deg, #3a9d5d, #1a7a3c)',
    legacy: 'https://offload-crew-training.vercel.app/',
    custom: 'https://training.offloadcrew.com',
  },
  {
    key: 'invoices',
    label: 'Invoice Chaser',
    icon: 'ti-cash-banknote',
    color: 'linear-gradient(160deg, #60a5fa, #2563eb)',
    legacy: 'https://invoice-chaser-silk.vercel.app/',
    custom: 'https://invoices.offloadcrew.com',
  },
  {
    // Lives inside this deployment, so the address is the same on any host.
    key: 'workflows',
    label: 'Workflows',
    icon: 'ti-route',
    color: 'linear-gradient(160deg, #9b6fd4, #5b3aa8)',
    url: '/workflow.html',
  },
  // Add more tiles by copying a block above. Mark anything a virtual
  // assistant must not see with `adminOnly: true`.
]

export const ROLES = ['admin', 'va']

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

// Who may sign in, and as what. Both lists are comma-separated emails in the
// launcher's environment. Admins are checked first, so an email in both lists
// is an admin. Anyone else who authenticates is refused (403), which matters
// because the Quote Builder's Supabase also holds customer accounts.
export function roleFor(email, env = process.env) {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return null
  if (parseList(env.LAUNCHER_ADMIN_EMAILS).includes(e)) return 'admin'
  if (parseList(env.LAUNCHER_VA_EMAILS).includes(e)) return 'va'
  return null
}

export function useCustomDomains(env = process.env) {
  return env.LAUNCHER_USE_CUSTOM_DOMAINS === '1'
}

export function tileUrl(app, custom) {
  if (app.url) return app.url
  return custom ? app.custom : app.legacy
}

// The tiles a role may open, in display order, with only the fields the
// browser needs to draw them.
export function tilesFor(role, env = process.env) {
  if (!ROLES.includes(role)) return []
  const custom = useCustomDomains(env)
  return APPS
    .filter(a => role === 'admin' || !a.adminOnly)
    .map(a => ({
      label: a.label,
      url: tileUrl(a, custom),
      icon: a.icon,
      color: a.color,
      badge: a.badge || null,
    }))
}
