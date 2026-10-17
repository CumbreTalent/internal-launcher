# Offload — Internal Apps Launcher

An iOS-style home screen for Offload's internal tools, behind a sign-in with
two roles. Static HTML plus two tiny Vercel functions; no build step, no
dependencies.

| Role | Sees |
|---|---|
| **Admin** | every tile, including QB Staging, Admin Console and Admin Staging |
| **Virtual assistant (VA)** | Quote Builder, Crew Training, Invoice Chaser, Workflows |

People sign in with their **Quote Builder email and password**; the launcher
talks to the same Supabase project. Which role someone gets is decided by two
email allowlists in the launcher's environment (below). Anyone who signs in
but is on neither list is refused, so a Tradezip customer account cannot see
internal tiles even though it lives in the same Supabase.

The tile list lives on the server (`api/_apps.js`) and is sent to the browser
already filtered by role, so a VA's browser never receives the staging or
console addresses at all.

---

## Set up on Vercel (~5 min)

1. vercel.com → the launcher project → **Settings → Environment Variables**:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | the Quote Builder **production** project URL (its Vercel env calls it `VITE_SUPABASE_URL`) |
   | `SUPABASE_ANON_KEY` | the matching anon/public key (`VITE_SUPABASE_ANON_KEY` there) |
   | `LAUNCHER_ADMIN_EMAILS` | your email(s), comma-separated |
   | `LAUNCHER_VA_EMAILS` | the VA's email(s), comma-separated |
   | `LAUNCHER_USE_CUSTOM_DOMAINS` | `0` for now (see "Put it on offloadcrew.com") |

   Framework preset stays **Other**, no build command. Vercel picks up `api/` on its own.
2. Push / redeploy. Open the URL: you get the sign-in card.
3. Sign in with your Quote Builder credentials. Admin sees seven tiles; the VA sees four.

To add or change who may sign in, edit the two env vars and redeploy. The
accounts themselves are the existing Quote Builder accounts; the launcher
creates none.

## Edit your apps

Open `api/_apps.js`. Each tile is one object:

```js
{
  key: 'quotes',
  label: 'Quote Builder',
  icon: 'ti-file-invoice',                       // any name from tabler.io/icons
  color: 'linear-gradient(160deg, #e8651a, #b23b1a)',
  legacy: 'https://rqr-quote-builder.vercel.app', // where it lives today
  custom: 'https://quotes.offloadcrew.com',       // where it lives after the domain move
  adminOnly: true,                               // optional: hide from the VA
  badge: 'TEST',                                 // optional: little yellow tag
}
```

Add a tile by copying a block. Anything a VA must not see gets `adminOnly: true`.
`npm test` checks that no admin-only address can reach a VA.

## Put it on offloadcrew.com

Each app stays its own Vercel project and gets a subdomain. In each project →
**Settings → Domains**, add the hostname; Vercel tells you the CNAME to create
at your DNS host.

| Subdomain | Vercel project | Git branch |
|---|---|---|
| `apps.offloadcrew.com` | internal-launcher | main |
| `quotes.offloadcrew.com` | rqr-quote-builder | main |
| `quotes-staging.offloadcrew.com` | rqr-quote-builder | staging |
| `console.offloadcrew.com` | tradezip-admin | main |
| `console-staging.offloadcrew.com` | tradezip-admin | staging |
| `training.offloadcrew.com` | offload-crew-training | main |
| `invoices.offloadcrew.com` | invoice-chaser | main |

Once they resolve, set `LAUNCHER_USE_CUSTOM_DOMAINS=1` on the launcher and
redeploy: every tile switches over. The old `*.vercel.app` addresses keep
working as aliases, so links already emailed to customers do not break.

Two things outside this repo must change with the move:

- **Quote Builder** `src/env.js` lists the production hostname; add
  `quotes.offloadcrew.com` or production will show the STAGING banner.
- **Supabase** (every project with a login): Authentication → URL Configuration →
  add the new hostnames to Redirect URLs, so password-reset and invite links work.

Then re-add the launcher to your Dock / home screen from `apps.offloadcrew.com`.

## Lock staging and the console (do this — hiding a tile is not security)

The launcher decides what a VA *sees*. What they can *open* is enforced by the
apps themselves:

- **Both staging tiles:** in Vercel, for `rqr-quote-builder` and `tradezip-admin`,
  **Settings → Deployment Protection → Vercel Authentication → Standard
  Protection**. Free on every plan; it covers preview deployments, which is
  what both staging sites are. Visitors must be signed in to Vercel *and* on
  your team, which the VA is not. After enabling, open the staging-branch
  domain in a private window to confirm it shows the Vercel sign-in.
  Trade-off: customer-facing staging links (sign, pay, crew) sit behind that
  sign-in too, so test them in a browser where you are signed in to Vercel.
- **Admin Console:** already requires its shared `ADMIN_PASSWORD`. Keep that out
  of the VA's hands and the console stays admin-only on any domain.
- **Staging Supabase projects:** sign-ups off, no VA account (current practice).

## Run it locally

No real project needed:

```bash
npm run dev:mock
```

Opens a fake Supabase at `http://localhost:8746` with three throwaway accounts
(see the top of `tests/mock-server.mjs`): one admin, one VA, one unlisted.

Against the real Supabase, copy `.env.example` to `.env`, fill it in, and run
`npx vercel dev`. Plain static servers won't work any more: the page needs `/api`.

```bash
npm test
```

runs the role and route tests (Node's built-in runner, no install).

## What this protects, and what it does not

- The browser only ever receives its role's tiles; the admin-only addresses are
  not in the page source.
- The launcher holds no privileged key. It verifies sessions by asking Supabase
  with the public anon key, so a leak of its config gives nothing new.
- `workflow.html` is a static file. It bounces visitors without a session to the
  sign-in form, but anyone who has the URL and is determined can still fetch
  the file. Nothing in it is a credential; if that ever changes, serve it from
  a function instead.
- The real gates for staging and the console are the ones in the section above.

## Use it like a native app

Open the URL in Safari → Share → **Add to Home Screen** (iPhone) or Chrome →
**Install app** (Mac). Sessions persist, so after the first sign-in it opens
straight to the grid until you sign out.
