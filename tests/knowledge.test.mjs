// The Knowledge tile: the page everyone gets holds no sales material, the
// committed build matches its source, and /api/knowledge hands the sales block
// to admins only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { build, buildFromDisk, readSource, PAGE, SALES_MODULE } from '../scripts/build-knowledge.mjs'
import handler from '../api/knowledge.js'
import { SALES } from '../api/_knowledge-sales.js'
import { fakeFetch, fakeRes, ENV } from './_helpers.mjs'

const { data, template } = readSource()
const page = fs.readFileSync(PAGE, 'utf8')

// Strings that exist only in the sales block: its JSON keys as they would be
// embedded, and its text (minus anything the shared data also says, such as a
// task name an offer-status row repeats).
const { sales: S, ...sharedData } = data
const shared = JSON.stringify(sharedData)
const SALES_MARKERS = [
  '"offerStatus"', '"discoveryQuestions"', '"byWhoHasIt"', '"edgeQuestions"', '"guardrails"', '"openItems"', '"sales":',
  S.intro, S.pivot.line, S.pivot.intro, S.pilot.default, S.pilot.addOn, S.pilot.rule, S.offerStatus.intro,
  ...S.positioning, ...S.pivot.moves, ...S.pivot.edgeQuestions, ...S.pivot.example,
  ...S.offerStatus.rows.flatMap(r => [r.doc, r.site, r.note || '']),
  ...S.discoveryQuestions.flatMap(g => g.questions),
  ...S.byWhoHasIt.flatMap(w => [w.says, w.hides, w.ask, w.add]),
  ...S.guardrails,
  ...S.openItems,
].filter(m => m && m.length > 12 && !shared.includes(JSON.stringify(m).slice(1, -1)))

test('the source has a sales block, and the committed outputs are the current build', () => {
  assert.ok(data.sales && data.sales.offerStatus && data.sales.discoveryQuestions.length, 'knowledge.json has the sales block')
  const out = buildFromDisk()
  assert.equal(page, out.page, 'knowledge.html is stale: run node scripts/build-knowledge.mjs')
  assert.equal(fs.readFileSync(SALES_MODULE, 'utf8'), out.salesModule, 'api/_knowledge-sales.js is stale: run node scripts/build-knowledge.mjs')
  assert.deepEqual(SALES, data.sales)
})

test('knowledge.html carries everything but the sales material', () => {
  assert.ok(SALES_MARKERS.length > 40, `only ${SALES_MARKERS.length} sales-only strings to check`)
  for (const m of SALES_MARKERS) {
    assert.ok(!page.includes(m), `sales material in knowledge.html: ${m.slice(0, 60)}`)
    // The text as an escaped JSON string would hold it, too.
    assert.ok(!page.includes(JSON.stringify(m).slice(1, -1)), `sales material (escaped) in knowledge.html: ${m.slice(0, 60)}`)
  }
  // The rest of the data is there, once, inlined in the page's script.
  assert.ok(page.includes(JSON.stringify(data.serviceAreas[0].tasks[0].what)))
  assert.ok(page.includes('"academyLinks"'))
  const inlined = JSON.parse(/const DATA = (.*);\n/.exec(page)[1].replace(/\\u003c/g, '<'))
  assert.deepEqual(Object.keys(inlined).sort(), Object.keys(data).filter(k => k !== 'sales').sort())
  assert.deepEqual(inlined.serviceAreas, data.serviceAreas)
  assert.equal(inlined.sales, undefined)
})

test('the page is a complete launcher page: guard, back link, no role switch, no light theme', () => {
  assert.match(page, /^<!DOCTYPE html>/)
  assert.ok(page.includes('<script src="auth.js"></script>'))
  assert.ok(page.includes("LauncherAuth.apps()"))
  assert.ok(page.includes("classList.add('in-launcher')"))
  assert.ok(page.includes('<a class="back" href="./index.html">&larr; Apps</a>'))
  assert.ok(page.includes('.in-launcher .bar .back { display: none; }'))
  assert.ok(!page.includes('data-role'), 'the Assistant/Admin switch is gone')
  assert.ok(!page.includes('prefers-color-scheme: light'))
  assert.ok(page.includes("LauncherAuth.api('/api/knowledge')"))
  assert.ok(page.includes("type: 'offload:open-app', key: 'training'"))
  assert.ok(/<\/script>\s*<\/body>\s*<\/html>\s*$/.test(page))
  // The inlined JSON can never close the script tag early: no "<" in it at all,
  // and the page's own closing tag is the only "</script" after the data.
  const blob = /const DATA = (.*);\n/.exec(page)[1]
  assert.ok(!blob.includes('<'), 'the inlined JSON has an unescaped "<"')
  assert.equal(page.slice(page.indexOf('const DATA = ')).match(/<\/script/g).length, 1)
})

test('build(): strips sales, escapes "<", refuses a template without the placeholder', () => {
  const out = build({ a: 1, note: '</script><!--', sales: { x: 1 } }, 'A __DATA__ Z')
  assert.equal(out.page, 'A {"a":1,"note":"\\u003c/script>\\u003c!--"} Z')
  assert.match(out.salesModule, /export const SALES = \{\n\s+"x": 1\n\}/)
  assert.throws(() => build({ sales: {} }, 'no placeholder'), /__DATA__/)
  assert.throws(() => build({ a: 1 }, '__DATA__'), /sales/)
})

// ── GET /api/knowledge ──

const req = (token, method = 'GET') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {} })
const call = (r, deps = {}) => { const res = fakeRes(); return handler(r, res, { env: ENV, fetchFn: fakeFetch, ...deps }).then(() => res) }

test('GET /api/knowledge refuses an assistant with 403 and sends no sales', async () => {
  for (const who of ['va@example.com', 'second.va@example.com']) {
    const res = await call(req(`tok:${who}`))
    assert.equal(res.statusCode, 403, who)
    assert.equal(res.body.sales, undefined)
    assert.ok(!JSON.stringify(res.body).includes('offerStatus'))
    assert.equal(res.headers['Cache-Control'], 'no-store')
  }
})

test('GET /api/knowledge: admins and the super admin get the sales block', async () => {
  for (const who of ['admin2@example.com', 'owner@offloadcrew.com']) {
    const res = await call(req(`tok:${who}`))
    assert.equal(res.statusCode, 200, who)
    assert.deepEqual(res.body, { sales: data.sales })
    assert.ok(res.body.sales.offerStatus.rows.length > 0)
  }
})

test('GET /api/knowledge: no token 401, no launcher role 403, POST 405, Supabase down 502', async () => {
  assert.equal((await call(req(null))).statusCode, 401)
  assert.equal((await call(req('nope'))).statusCode, 401)
  assert.equal((await call(req('tok:customer@contractor.com'))).statusCode, 403)
  assert.equal((await call(req('tok:owner@offloadcrew.com', 'POST'))).statusCode, 405)
  assert.equal((await call(req('tok:owner@offloadcrew.com'), { fetchFn: async () => { throw new Error('ECONNRESET') } })).statusCode, 502)
})
