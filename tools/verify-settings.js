'use strict'
/*
 * VERIFY SETTINGS — exercises the creators / assistant settings over real HTTP.
 *
 * The operator asked for "a nice place in the dashboard panel to put those
 * exact names as-is". This proves the round trip: POST the names, read them
 * back from the API, and confirm the bot's own card header uses them.
 */
const http = require('http')
const assert = require('assert')

const PORT = 3999
process.env.PORT = String(PORT)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/axyon'
process.env.DASHBOARD_PASSWORD = 'test-pass-123'

let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name} ${detail}`) }
}

function call (path, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? Buffer.from(opts.body) : null
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path,
      method: opts.method || 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.csrf ? { 'x-architect-csrf': opts.csrf } : {})
      }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main () {
  const store = require('../src/axyon-store')
  await store.ensureSchema()

  /* Boot the real server module (it starts the health + dashboard server). */
  require('../src/server')
  await new Promise(r => setTimeout(r, 1200))

  console.log('\n=== 1. Login ===')
  const login = await call('/dashboard/api/login', {
    method: 'POST', body: JSON.stringify({ password: 'test-pass-123' })
  })
  ok('login succeeds', login.status === 200, String(login.status))
  const csrf = login.json?.csrf
  const cookie = String(login.headers['set-cookie'] || '').split(';')[0]
  ok('csrf issued', !!csrf)
  ok('session cookie issued', cookie.startsWith('architect_session='))

  console.log('\n=== 2. Creators round trip ===')
  const save = await call('/dashboard/api/admin/action', {
    method: 'POST',
    cookie,
    csrf,
    body: JSON.stringify({ action: 'settings', creators: ['Lil Clutch', 'Montai'], botName: 'Architect' })
  })
  ok('save creators returns 200', save.status === 200, `${save.status} ${save.text.slice(0, 120)}`)
  ok('save creators reports ok', save.json?.ok === true, JSON.stringify(save.json).slice(0, 160))

  const snap = await call('/dashboard/api/admin', { cookie })
  ok('snapshot returns 200', snap.status === 200, String(snap.status))
  const creators = snap.json?.settings?.creators
  ok('creators persisted as an array', Array.isArray(creators), JSON.stringify(creators))
  ok('creator one is exactly "Lil Clutch"', creators?.[0] === 'Lil Clutch', String(creators?.[0]))
  ok('creator two is exactly "Montai"', creators?.[1] === 'Montai', String(creators?.[1]))
  ok('bot name persisted', snap.json?.settings?.botName === 'Architect')

  console.log('\n=== 3. The bot card uses those names ===')
  const greetings = require('../src/greetings')
  const settings = await store.settings()
  const card = greetings.firstGreeting({
    userId: '2348012345678', name: 'Test', rank: 'E', grade: 1, level: 1,
    xp: 0, zen: 0, coins: 0, hp: 100, maxHp: 100, atk: 6, def: 4,
    powerEnergy: 50, maxPowerEnergy: 50, class: 'Fighter'
  }, '!', settings)
  ok('card header shows Lil Clutch', card.includes('Lil Clutch'))
  ok('card header shows Montai', card.includes('Montai'))
  ok('card header does not show Chat Nova', !/Chat Nova/i.test(card))

  console.log('\n=== 4. Validation rejects bad input ===')
  const bad = await call('/dashboard/api/admin/action', {
    method: 'POST', cookie, csrf,
    body: JSON.stringify({ action: 'settings', creators: [] })
  })
  ok('empty creators rejected', bad.status === 400, String(bad.status))
  ok('rejection carries a message', !!bad.json?.message, JSON.stringify(bad.json).slice(0, 120))

  const long = await call('/dashboard/api/admin/action', {
    method: 'POST', cookie, csrf,
    body: JSON.stringify({ action: 'settings', creators: ['x'.repeat(60)] })
  })
  ok('over-long creator name rejected', long.status === 400, String(long.status))

  console.log('\n=== 5. Assistant settings ===')
  const ai = await call('/dashboard/api/admin/action', {
    method: 'POST', cookie, csrf,
    body: JSON.stringify({ action: 'settings', aiEnabled: true, aiTimeoutMs: 15000 })
  })
  ok('assistant settings saved', ai.status === 200 && ai.json?.ok === true, String(ai.status))
  const snap2 = await call('/dashboard/api/admin', { cookie })
  ok('aiEnabled persisted', snap2.json?.settings?.aiEnabled === true)
  ok('aiTimeoutMs persisted', snap2.json?.settings?.aiTimeoutMs === 15000, String(snap2.json?.settings?.aiTimeoutMs))

  const badTimeout = await call('/dashboard/api/admin/action', {
    method: 'POST', cookie, csrf,
    body: JSON.stringify({ action: 'settings', aiTimeoutMs: 999999 })
  })
  ok('out-of-range timeout rejected', badTimeout.status === 400, String(badTimeout.status))

  console.log('\n=== 6. CSRF is still enforced ===')
  const noCsrf = await call('/dashboard/api/admin/action', {
    method: 'POST', cookie,
    body: JSON.stringify({ action: 'settings', creators: ['Hacker'] })
  })
  ok('POST without CSRF is refused', noCsrf.status === 403, String(noCsrf.status))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('FAILURES: ' + failures.join(', '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('CRASHED:', e); process.exit(1) })
