// Makes the key pair for launcher single sign-on.
//
//   node scripts/make-keys.mjs
//
// Writes both values to .launcher-keys.txt (git-ignored) and prints where.
// LAUNCHER_SIGNING_KEY is secret: it goes ONLY on the launcher's Vercel
// project. LAUNCHER_PUBLIC_KEY goes on every app's Vercel project.
// Running it again makes a NEW pair; then every app needs the new public key.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair } from '../api/_ticket.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, '.launcher-keys.txt')

if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} already exists. Re-run with --force to replace it (every app will then need the new public key).`)
  process.exit(1)
}

const { signingKey, publicKey } = generateKeyPair()
fs.writeFileSync(out, [
  '# Offload Crew Launcher single sign-on keys. Do not commit or share this file.',
  '',
  '# Launcher project ONLY (secret):',
  `LAUNCHER_SIGNING_KEY=${signingKey}`,
  '',
  '# Every app project (Quote Builder, Admin Console, Invoice Chaser, Crew Training):',
  `LAUNCHER_PUBLIC_KEY=${publicKey}`,
  '',
].join('\n'), { mode: 0o600 })

console.log(`Wrote ${out}`)
console.log(`Public key (safe to share): ${publicKey}`)
