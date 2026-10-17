// Launch tickets: the launcher's half of single sign-on.
//
// A ticket is `v1.<payload>.<signature>` (base64url), signed with the
// launcher's Ed25519 private key (LAUNCHER_SIGNING_KEY). Each app verifies it
// with the matching public key using receiver/_launcher.js. Tickets name one
// app, one person and their launcher role, and last 60 seconds.

import crypto from 'node:crypto'

export const TICKET_PREFIX = 'v1'
export const TICKET_ISSUER = 'offload-crew-launcher'
export const TICKET_TTL_S = 60

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

let cached = { raw: null, key: null }
function privateKeyFrom(raw) {
  if (cached.raw === raw) return cached.key
  const key = crypto.createPrivateKey({ key: Buffer.from(String(raw).trim(), 'base64'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('LAUNCHER_SIGNING_KEY is not an Ed25519 key')
  cached = { raw, key }
  return key
}

export function signTicket({ aud, sub, role }, signingKey, { now = Date.now(), ttl = TICKET_TTL_S } = {}) {
  const iat = Math.floor(now / 1000)
  const payload = {
    iss: TICKET_ISSUER,
    aud,
    sub: String(sub).trim().toLowerCase(),
    role,
    iat,
    exp: iat + ttl,
    jti: crypto.randomUUID(),
  }
  const head = `${TICKET_PREFIX}.${b64url(JSON.stringify(payload))}`
  const sig = crypto.sign(null, Buffer.from(head), privateKeyFrom(signingKey))
  return `${head}.${b64url(sig)}`
}

// A fresh key pair, as the two single-line values the env vars expect.
export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return {
    signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

// The public half of a signing key, so the README/setup script can print it.
export function publicKeyFor(signingKey) {
  return crypto.createPublicKey(privateKeyFrom(signingKey)).export({ format: 'der', type: 'spki' }).toString('base64')
}
