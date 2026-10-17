# Offload Crew Launcher

The one place to open every Offload Crew internal tool. It looks and works
like a phone home screen: sign in once, tap an app, and it opens full-screen
inside the launcher, already signed in. A Home button takes you back, and apps
you have opened keep running, so switching between them is instant.

| Role | Sees |
|---|---|
| **Super admin** | every tile, plus **People**, where people are added and removed |
| **Admin** | every tile except People: Quote Builder, QB Staging, Admin Staging, Crew Training, Invoice Chaser, Workflows |
| **Assistant** | Quote Builder, Crew Training, Invoice Chaser, Workflows |

People sign in with their **Quote Builder** login. The super admin is set only
by `LAUNCHER_SUPERADMIN_EMAILS` in Vercel, so no screen can create one.
Everyone else's role is stored on their own Quote Builder login (Supabase
`app_metadata.launcher_role`), which only the server can write, and is managed
on the People screen. Anyone else who signs in is refused, so a Tradezip
customer account cannot see internal tiles even though it lives in the same
Supabase.

The live **Admin Console** tile is hidden for now, for everyone: that
deployment has no database settings in Vercel, so it cannot load data. Use
Admin Staging. To bring it back, configure tradezip-admin's Production env,
then delete the `hidden: true` line on its tile in `api/_apps.js`.

The tile list lives on the server (`api/_apps.js`) and reaches the browser
already filtered by role: an assistant's browser never receives the staging,
console or People addresses at all.

## Adding and removing people (super admin)

Open **People**. Type a name and email, pick Admin or Assistant, and click
**Add person**.

- **New to the Quote Builder:** a login is created and a temporary password is
  shown once. Send it to them privately with the launcher address. They sign
  in and use **Change password** at the bottom of the home screen. A new
  admin is also made a Quote Builder admin; a new assistant keeps the Quote
  Builder's default assistant role.
- **Already has a Quote Builder login:** they get launcher access and keep
  their own password.
- **Their other tools:** nothing to do. Invoice Chaser and Crew Training
  create their account the first time they open it from the launcher: admins
  as admins, assistants as members (Invoice Chaser) and trainees (Crew
  Training). QB Staging and the Admin Console don't create accounts.

Each row also has **Reset password** (a new temporary password, shown once)
and **Remove**, which takes away launcher access at once. Their accounts in
each tool stay, so nothing they made is lost; those accounts have no password
unless they set one through that tool's own "forgot password".

## How one sign-in reaches every app

Each app keeps its own login system. When you open one, the launcher hands it a
**launch ticket**: a pass that says who you are, your launcher role and which
app it is for, valid for 60 seconds and signed with the launcher's private key.
The app checks the signature with the launcher's public key, then signs you in
its own way:

| App | How it signs you in |
|---|---|
| Quote Builder | finds your profile by email and starts a normal Supabase session for it |
| Invoice Chaser, Crew Training | the same, and if you have no account yet, creates one first (no password; role from the launcher) |
| Admin Console | admins only; issues its usual 12-hour session, as the shared password would |

A super admin opens apps as an admin; apps only know admin and assistant.
Apps keep the final say on everything else: deactivated access in the Quote
Builder, for example, still means no sign-in, with a page that says so.

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
| `SUPABASE_URL` | the Quote Builder **live** project URL (`VITE_SUPABASE_URL` there) |
| `SUPABASE_ANON_KEY` | the matching anon key (`VITE_SUPABASE_ANON_KEY` there) |
| `SUPABASE_SERVICE_ROLE_KEY` | the same project's service key, marked Sensitive. Used only by the People screen, behind the super-admin check, to create logins and set roles |
| `LAUNCHER_SUPERADMIN_EMAILS` | the super admin's email (comma-separated if ever more than one) |
| `LAUNCHER_USE_CUSTOM_DOMAINS` | `0` until the offloadcrew.com addresses work, then `1` |
| `LAUNCHER_SIGNING_KEY` | from `.launcher-keys.txt`. Add this **last**, once every app below is deployed |

Tick Production and Preview for each. Until `LAUNCHER_SIGNING_KEY` is set, the
launcher works and each app simply asks for its own login, as before.

### 3. App settings (each app's Vercel project, Production and Preview)

| App | Add |
|---|---|
| offload-quote-builder | `LAUNCHER_PUBLIC_KEY` |
| tradezip-admin | `LAUNCHER_PUBLIC_KEY` |
| invoice-chaser | `LAUNCHER_PUBLIC_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from that app's Supabase project (Settings → API) |
| offload-crew-training | `LAUNCHER_PUBLIC_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from that app's Supabase project |

The Quote Builder and Admin Console already have their service keys. Invoice
Chaser and Crew Training need theirs to create accounts on a first visit.

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
  legacy: 'https://offload-quote-builder.vercel.app', // where it lives today
  custom: 'https://quotes.offloadcrew.com',       // where it lives after the domain move
  sso: true,                                      // the app has /api/launch
  embed: true,                                    // may open inside the launcher
  adminOnly: true,                                // optional: admins and super admin only
  superadminOnly: true,                           // optional: super admin only
  hidden: true,                                   // optional: nobody, for a broken app
  badge: 'TEST',                                  // optional: little yellow tag
}
```

`npm test` checks that no admin-only address can reach an assistant, and that
People stays super-admin only.

## Put it on offloadcrew.com

Each app stays its own Vercel project and gets a subdomain. In each project →
**Settings → Domains**, add the hostname; Vercel shows the record to create at
Namecheap.

| Subdomain | Vercel project | Git branch |
|---|---|---|
| `apps.offloadcrew.com` | this launcher | main |
| `quotes.offloadcrew.com` | offload-quote-builder | main |
| `quotes-staging.offloadcrew.com` | offload-quote-builder | staging |
| `console.offloadcrew.com` | tradezip-admin | main |
| `console-staging.offloadcrew.com` | tradezip-admin | staging |
| `training.offloadcrew.com` | offload-crew-training | main |
| `invoices.offloadcrew.com` | invoice-chaser | main |

Then set `LAUNCHER_USE_CUSTOM_DOMAINS=1` here and redeploy. Every app allows
itself to be shown inside `https://apps.offloadcrew.com` and nowhere else.
Also add `quotes.offloadcrew.com` to the Quote Builder's production host list
in `src/env.js`, or production shows the STAGING banner.

## Staging is locked to admins (no Vercel login)

Every test build of the Quote Builder (QB Staging) and the Admin Console
(Admin Staging) is locked by a small check in front of the site
(`middleware.js` in each app, logic in `receiver/_gate.js`, copied to each app
as `api/_gate.js`). It lets a browser in only after a launcher **admin or
super admin** has opened that site from the launcher; that unlocks the browser
for 12 hours. Anyone else sees "open this through the launcher". Assistants
never get there: staging tiles are admin-only and the apps refuse their
tickets too. Live sites are never affected.

Coming from a locked page, "Open through the launcher" signs you in and sends
you straight back to that exact test build. The launcher only ever sends
tickets to that app's own test addresses (`previewHosts` in `api/_apps.js`).

Needs `LAUNCHER_GATE_SECRET` (Preview) on each locked Vercel project. Vercel's
own login (Deployment Protection → Vercel Authentication) is switched off on
those projects, so admins sign in once, with the launcher. Stripe's webhook
stays reachable on QB Staging; customer-facing test links (signing, payment,
invitations) open only in a browser that came through the launcher.

The Admin Console's own password still works for anyone who has it, so keep it
to admins.

## Run it locally

```bash
npm run dev:mock
```

Opens everything at `http://localhost:8746`: the launcher, a fake Supabase
project per app, and six fake apps that run the real receiver code, including
automatic accounts. Throwaway sign-ins for each role are listed at the top of
`tests/mock-server.mjs`.

```bash
npm test
```

runs the role, People, ticket and receiver tests with Node's built-in runner.

## What this protects, and what it does not

- The browser only ever receives its role's tiles.
- Only the super admin can add, change or remove people; the server checks
  this on every request. The super admin can't be created or removed from any
  screen, only in Vercel.
- The launcher holds the Quote Builder's service key so People can create
  logins. It is used only behind the super-admin check and never reaches a
  browser.
- Tickets last 60 seconds, name one app, and are signed with a key only the
  launcher holds. A ticket for one app is refused by every other app; an
  assistant's ticket can never open the Admin Console.
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
