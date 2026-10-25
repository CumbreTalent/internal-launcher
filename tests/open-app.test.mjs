// The launcher's rules for `offload:open-app` messages from embedded apps
// (open-app.js, used by index.html): which frames, origins and keys count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { tilesFor } from '../api/_apps.js'
import { ENV } from './_helpers.mjs'

const sandbox = { window: {}, URL }
vm.runInNewContext(fs.readFileSync(new URL('../open-app.js', import.meta.url), 'utf8'), sandbox)
const { openAppRequest } = sandbox.window.LauncherMessages
// Arrays made in the other realm have another Array.prototype; copy them here.
const allowedOrigins = (...args) => Array.from(sandbox.window.LauncherMessages.allowedOrigins(...args))

const SELF = 'https://apps.offloadcrew.com'
const tiles = tilesFor('va', ENV)
const tile = key => tiles.find(t => t.key === key)
const knowledgeWin = {}, trainingWin = {}, strangerWin = {}
const frames = [{ tile: tile('knowledge'), contentWindow: knowledgeWin }, { tile: tile('training'), contentWindow: trainingWin }]
const msg = (data, { source = knowledgeWin, origin = SELF } = {}) => openAppRequest({ data, source, origin }, { frames, tiles, selfOrigin: SELF })
const HASH = '#module/desk-compliance/reading-verifying-a-coi'

test('the Knowledge page (launcher origin) may open Crew Training at a fragment', () => {
  const r = msg({ type: 'offload:open-app', key: 'training', hash: HASH })
  assert.equal(r.tile.key, 'training')
  assert.equal(r.hash, HASH)
  assert.equal(msg({ type: 'offload:open-app', key: 'training', hash: '#day/3/invoicing-draws-payment-tracking' }).hash, '#day/3/invoicing-draws-payment-tracking')
})

test('an external app may message from either of its own addresses, nowhere else', () => {
  for (const origin of ['https://offload-crew-training.vercel.app', 'https://training.offloadcrew.com']) {
    assert.equal(msg({ type: 'offload:open-app', key: 'knowledge', hash: '#subs/tasks' }, { source: trainingWin, origin }).tile.key, 'knowledge', origin)
  }
  for (const origin of [SELF, 'https://evil.example', 'https://training.offloadcrew.com.evil.example', 'http://training.offloadcrew.com', 'null', '']) {
    assert.equal(msg({ type: 'offload:open-app', key: 'knowledge' }, { source: trainingWin, origin }), null, origin)
  }
  assert.deepEqual(allowedOrigins(tile('training'), SELF), ['https://offload-crew-training.vercel.app', 'https://training.offloadcrew.com'])
  assert.deepEqual(allowedOrigins(tile('knowledge'), SELF), [SELF])
})

test('a launcher page may only message from the launcher origin', () => {
  for (const origin of ['https://offload-crew-training.vercel.app', 'https://evil.example', 'null']) {
    assert.equal(msg({ type: 'offload:open-app', key: 'training' }, { origin }), null, origin)
  }
})

test('messages from windows the launcher did not open are ignored, whatever they claim', () => {
  assert.equal(msg({ type: 'offload:open-app', key: 'training' }, { source: strangerWin }), null)
  assert.equal(msg({ type: 'offload:open-app', key: 'training' }, { source: null }), null)
  assert.equal(openAppRequest({ data: { type: 'offload:open-app', key: 'training' }, source: knowledgeWin, origin: SELF }, { frames: [], tiles, selfOrigin: SELF }), null)
})

test('unknown keys and tiles outside this role are ignored alike', () => {
  assert.equal(msg({ type: 'offload:open-app', key: 'nope' }), null)
  assert.equal(msg({ type: 'offload:open-app', key: 'people' }), null, 'super admin only')
  assert.equal(msg({ type: 'offload:open-app', key: 'quotes-staging' }), null, 'admin only')
  assert.equal(msg({ type: 'offload:open-app', key: 'console' }), null, 'hidden')
  const admin = tilesFor('admin', ENV)
  assert.equal(openAppRequest({ data: { type: 'offload:open-app', key: 'quotes-staging' }, source: knowledgeWin, origin: SELF }, { frames, tiles: admin, selfOrigin: SELF }).tile.key, 'quotes-staging')
})

test('anything that is not an open-app message is ignored', () => {
  for (const data of [null, undefined, 'offload:open-app', 42, {}, { type: 'offload:open-app' }, { type: 'offload:open-app', key: 7 }, { type: 'open-app', key: 'training' }, { type: 'offload:close-app', key: 'training' }]) {
    assert.equal(msg(data), null, JSON.stringify(data))
  }
})

test('the hash must be a plain fragment; otherwise the tile opens at its front page', () => {
  for (const hash of [undefined, 7, '', '#', 'module/x', '#a b', '#<script>', '#"x"', '#' + 'x'.repeat(2001), 'https://evil.example/#x']) {
    const r = msg({ type: 'offload:open-app', key: 'training', hash })
    assert.equal(r.tile.key, 'training')
    assert.equal(r.hash, '', String(hash))
  }
  for (const hash of ['#x', '#module/desk-pc/change-orders-%E2%80%94-signed', "#day/2/owner's-inbox", '#a/b?c=d&e=f']) {
    assert.equal(msg({ type: 'offload:open-app', key: 'training', hash }).hash, hash)
  }
})
