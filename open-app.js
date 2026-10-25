// Requests from apps running inside the launcher. Plain script, shared with the
// tests (tests/open-app.test.mjs), so the rules live in one place.
//
// An embedded app asks the launcher to open another tile by posting to its
// parent window:
//
//   window.parent.postMessage({ type: 'offload:open-app', key: 'training', hash: '#module/desk-compliance/reading-verifying-a-coi' }, '*')
//
//   type   always 'offload:open-app'
//   key    the tile to open (its key in api/_apps.js)
//   hash   optional fragment, '#' first, appended to the tile's final address
//
// The launcher honours a message only when all of these hold:
//   - it comes from the window of a tile the launcher itself opened in a frame
//     (event.source is that frame's contentWindow);
//   - event.origin is one of that tile's own addresses as served by /api/apps
//     (`origins`: its vercel.app and offloadcrew.com homes), or, for a page
//     inside the launcher (url starting with "/"), the launcher's own origin;
//   - `key` names a tile this person may open (it is in the tiles /api/apps
//     returned for their role; unknown and forbidden keys look the same).
// Anything else is ignored. A hash that is not a plain URL fragment is dropped
// and the tile opens at its front page. The message carries nothing secret, so
// an app may post it with targetOrigin '*'.
//
// Exposes window.LauncherMessages.openAppRequest(event, { frames, tiles, selfOrigin })
//   → { tile, hash } to open, or null to ignore.

(function (root) {
  const TYPE = 'offload:open-app'
  // RFC 3986 fragment characters, nothing else; at most 2000 characters.
  const FRAGMENT = /^#[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]{0,2000}$/

  function originOf(url, base) {
    try { return new URL(url, base).origin } catch (e) { return null }
  }

  // The origins a tile may message from while framed.
  function allowedOrigins(tile, selfOrigin) {
    if (!tile || typeof tile.url !== 'string') return []
    if (tile.url.charAt(0) === '/') return [selfOrigin]
    const list = [originOf(tile.url, selfOrigin)].concat(Array.isArray(tile.origins) ? tile.origins : [])
    return list.filter(function (o, i) { return typeof o === 'string' && o && o !== 'null' && list.indexOf(o) === i })
  }

  // frames: [{ tile, contentWindow }] for the tiles running in the launcher.
  // tiles: what /api/apps returned for this person.
  function openAppRequest(event, opts) {
    const d = event && event.data
    if (!d || typeof d !== 'object' || d.type !== TYPE || typeof d.key !== 'string') return null
    const frames = (opts && opts.frames) || []
    const from = frames.find(function (f) { return f && f.contentWindow && event.source === f.contentWindow })
    if (!from) return null
    if (allowedOrigins(from.tile, opts.selfOrigin).indexOf(event.origin) < 0) return null
    const tile = ((opts && opts.tiles) || []).find(function (t) { return t && t.key === d.key })
    if (!tile) return null
    const hash = typeof d.hash === 'string' && FRAGMENT.test(d.hash) && d.hash !== '#' ? d.hash : ''
    return { tile: tile, hash: hash }
  }

  root.LauncherMessages = { openAppRequest: openAppRequest, allowedOrigins: allowedOrigins, TYPE: TYPE }
})(typeof window !== 'undefined' ? window : globalThis)
