# Offload Crew Launcher

The one place to open every Offload Crew internal tool. It looks and works
like a phone home screen: sign in once, tap an app, and it opens full-screen
inside the launcher, already signed in. A Home button takes you back, and apps
you have opened keep running, so switching between them is instant.

| Role | Sees |
|---|---|
| **Admin** | every tile, including QB Staging, Admin Console and Admin Staging |
| **Virtual assistant (VA)** | Quote Builder, Crew Training, Invoice Chaser, Workflows |

People sign in with their **Quote Builder email and password**. Which role
someone gets is decided by two email allowlists in the launcher's settings.
Anyone else who signs in is refused, so a Tradezip customer account cannot see
internal tiles even though it lives in the same Supabase.

The tile list lives on the server (`api/_apps.js`) and reaches the browser
already filtered by role: a VA's browser never receives the staging or console
addresses at all.

## How one sign-in reaches every app

Each app keeps its own login system. When you open one, the launcher hands it a
**launch ticket**: a pass that says who you are, your launcher role and which
app it is for, valid for 60 seconds and signed with the launcher's private key.
The app checks the signature with the launcher's public key, then signs you in
its own way:

| App | How it signs you in |
|---|---|
| Quote Builder, Invoice Chaser, Crew Training | finds your profile there by email and starts a normal Supabase session for it |
| Admin Console | admins only; issues its usual 12-hour session, as the shared password would |

Each app still has the final say. No account in that app under the same email,
or deactivated access in the Quote Builder, means no sign-in, with a page that
says so. Nothing is ever created in an app by the launcher.

The receiving code is `receiver/_launcher.js`. Every app carries an identical
copy as `api/_launcher.js` (`api/_launcher.mjs` in Crew Training) next to a
small `api/launch.js` route. Change the copy here, run `npm test`, then copy it
out; never edit a copy in place.

**In the launcher window or a new tab?** Apps open inside the launcher when
they share its domain: the launcher on `apps.offloadcrew.com`, the apps on
`*.offloadcrew.com`. Before the domain move, browsers treat each `vercel.app`
address as an unrelated site and block logins inside a frame, so apps open in a
new tab instead, still signed in. Staging always opens in a tab, because
Vercel's own sign-in page refuses to show inside another page.

---

## Set up

### 1. Make the key pair (once)

```bash
node scripts/make-keys.mjs
```

This writes `.launcher-keys.txt`, which git ignores, with two values.
`LAUNCHER_SIGNING_KEY` is secret and goes on the launcher only.
`LAUNCHER_PUBLIC_KEY` goes on every app. Don't commit or share the file.

### 2. Launcher settings (Vercel → this project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Quote Builder **production** project URL (`VITE_SUPABASE_URL` there) |
| `SUPABASE_ANON_KEY` | the matching anon key (`VITE_SUPABASE_ANON_KEY` there) |
| `LAUNCHER_ADMIN_EMAILS` | admin emails, comma-separated |
| `LAUNCHER_VA_EMAILS` | VA emails, comma-separated |
| `LAUNCHER_USE_CUSTOM_DOMAINS` | `0` until the offloadcrew.com addresses work, then `1` |
| `LAUNCHER_SIGNING_KEY` | from `.launcher-keys.txt` — add this **last**, once every app below is deployed |

Tick Production and Preview for each. Until `LAUNCHER_SIGNING_KEY` is set, the
launcher works and each app simply asks for its own login, as before.

### 3. App settings (each app's Vercel project, Production and Preview)

| App | Add |
|---|---|
| rqr-quote-builder | `LAUNCHER_PUBLIC_KEY` |
| tradezip-admin | `LAUNCHER_PUBLIC_KEY` |
| invoice-chaser | `LAUNCHER_PUBLIC_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from that app's Supabase project (Settings → API) |
| offload-crew-training | `LAUNCHER_PUBLIC_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from that app's Supabase project |

The Quote Builder and Admin Console already have their service keys. Each
person needs an account in each app under the **same email** as the launcher.

Check an app is ready by opening `<app address>/api/launch` directly. It
should say "Open this app from the Offload Crew Launcher". If it says
"launcher sign-in is not set up yet", a setting is missing.

## Edit your apps

Open `api/_apps.js`. Each tile is one object:

```js
{
  key: 'quotes',                                  // also the app name in tickets
  label: 'Quote Builder',
  icon: 'ti-file-invoice',                        // any name from tabler.io/icons
  color: 'linear-gradient(160deg, #e8651a, #b23b1a)',
  legacy: 'https://rqr-quote-builder.vercel.app', // where it lives today
  custom: 'https://quotes.offloadcrew.com',       // where it lives after the domain move
  sso: true,                                      // the app has /api/launch
  embed: true,                                    // may open inside the launcher
  adminOnly: true,                                // optional: hide from the VA
  badge: 'TEST',                                  // optional: little yellow tag
}
```

`npm test` checks that no admin-only address can reach a VA.

## Put it on offloadcrew.com

Each app stays its own Vercel project and gets a subdomain. In each project →
**Settings → Domains**, add the hostname; Vercel shows the record to create at
Namecheap.

| Subdomain | Vercel project | Git branch |
|---|---|---|
| `apps.offloadcrew.com` | this launcher | main |
| `quotes.offloadcrew.com` | rqr-quote-builder | main |
| `quotes-staging.offloadcrew.com` | rqr-quote-builder | staging |
| `console.offloadcrew.com` | tradezip-admin | main |
| `console-staging.offloadcrew.com` | tradezip-admin | staging |
| `training.offloadcrew.com` | offload-crew-training | main |
| `invoices.offloadcrew.com` | invoice-chaser | main |

Then set `LAUNCHER_USE_CUSTOM_DOMAINS=1` here and redeploy. Every app allows
itself to be shown inside `https://apps.offloadcrew.com` and nowhere else.
Also add `quotes.offloadcrew.com` to the Quote Builder's production host list
in `src/env.js`, or production shows the STAGING banner.

## Lock staging

Hiding a tile is not security. In Vercel, for `rqr-quote-builder`, turn on
**Settings → Deployment Protection → Vercel Authentication** (Standard
Protection). `tradezip-admin` already has it. Don't add the VA to the Vercel
team. The Admin Console's own password still works for anyone who has it, so
keep it to admins.

## Run it locally

```bash
npm run dev:mock
```

Opens everything at `http://localhost:8746`: the launcher, a fake Supabase,
and six fake apps that run the real receiver code. Three throwaway accounts
are listed at the top of `tests/mock-server.mjs`.

```bash
npm test
```

runs the role, ticket and receiver tests with Node's built-in runner.

## What this protects, and what it does not

- The browser only ever receives its role's tiles.
- Tickets last 60 seconds, name one app, and are signed with a key only the
  launcher holds. A ticket for one app is refused by every other app; a VA's
  ticket can never open the Admin Console.
- Tickets travel in the app's address, so someone with access to your browser
  history could reuse one within its 60 seconds. Sessions themselves travel
  the way Supabase's own magic links do, in the part of the address servers
  never see.
- Signing out of the launcher closes the apps in it but does not sign you out
  of each app. Use each app's own sign-out on a shared computer.
- A page that refuses to be framed, like Stripe's onboarding, won't show
  inside the launcher. Use the app bar's "open in a new tab" button for those.
- `workflow.html` is a static file. It bounces visitors without a session to
  the sign-in form, but anyone with its address can still fetch it.

## Use it like an app

Open the address in Chrome on a Mac and choose **Install** from the address
bar, or in Safari on iPhone use Share → **Add to Home Screen**. It opens in its
own window with no browser bars.
