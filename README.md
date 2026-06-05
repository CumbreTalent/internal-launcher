# Offload — Internal Apps Launcher

An iOS-style home screen that links to your internal tools. Pure static HTML —
no build step, no dependencies, no login.

## Edit your apps

Open `index.html` and find the `APPS` array near the bottom (inside the
`<script>` block). Each app is one object:

```js
{
  label: 'Quote Builder',
  url: 'https://rqr-quote-builder.vercel.app',
  icon: 'ti-file-invoice',                     // any name from tabler.io/icons
  color: 'linear-gradient(160deg, #e8651a, #b23b1a)',
}
```

- **Replace the Onboarding `url`** with your real onboarding app URL (it shows a
  "SET URL" badge until you do).
- **Add an app** by copying a block and changing the four fields.
- **Pick icons** at https://tabler.io/icons — use the name prefixed with `ti-`.

## Deploy to Vercel (~2 min)

1. Push this folder to a new GitHub repo:
   ```bash
   cd internal-launcher
   git init && git add . && git commit -m "initial"
   git remote add origin <your-new-repo-url>
   git push -u origin main
   ```
2. vercel.com → **Add New → Project** → import the repo.
3. Framework preset: **Other** (it's static). No build command, no env vars.
4. **Deploy.** You get a URL like `offload-apps.vercel.app`.

## Use it like a native app (iPhone)

Open the URL in Safari → Share → **Add to Home Screen**. It launches
full-screen with no browser chrome, like a real app.
