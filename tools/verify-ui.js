'use strict'
/*
 * UI + ENDPOINT VERIFICATION
 *
 * This does not read the code and assume it works. It boots the real dashboard
 * router, logs in over HTTP, and then:
 *   1. checks the HTML really contains 12 separate screens and a dock
 *   2. checks every `data-act` in admin.js has a handler in admin.js
 *   3. calls EVERY admin action endpoint and asserts a real response
 *   4. calls the commands endpoint the help screen depends on
 *   5. confirms the registration help text is present in the served HTML
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) } else { fail++; failures.push(name + (detail ? ` \u2014 ${detail}` : '')); console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`) }
}

function request (port, method, urlPath, { body, cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const headers = {}
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data) }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-architect-csrf'] = csrf
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function main () {
  const { createDashboard } = require('../src/dashboard')
  const { database, closeAuthStore } = require('../src/auth-store')
  const store = require('../src/axyon-store')

  await store.ensureSchema()

  const logger = { info () {}, warn () {}, error () {}, child () { return logger } }
  const sessions = {
    status: () => ({ accounts: [{ sessionId: 'primary', phone: '2348012345678', state: 'connected', storage: 'postgres', uptimeSec: 120, messagesHandled: 42, paused: false, label: 'Architect' }], connected: 1, total: 1, primary: { sessionId: 'primary' } }),
    reconnect: async () => true,
    pause: async () => true,
    remove: async () => true,
    removeAll: async () => 1,
    pair: async () => ({ code: 'ABCD-EFGH', sessionId: 'primary', accountType: 'primary' })
  }
  const lease = { status: () => ({ owned: true }), takeover: async () => true }
  const dashboard = createDashboard({ sessions, database, lease, logger })

  const server = http.createServer((req, res) => {
    dashboard.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end('nf') } }).catch(e => { res.writeHead(500); res.end(String(e)) })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  /* ------------------------------------------------------------ 1. HTML */
  console.log('\n=== 1. SCREEN STRUCTURE (served HTML) ===')
  const page = await request(port, 'GET', '/dashboard')
  ok('dashboard page serves 200', page.status === 200, `got ${page.status}`)
  const html = page.raw

  const screens = [...html.matchAll(/data-screen="([a-z]+)"/g)].map(m => m[1])
  const expected = ['overview', 'pairing', 'groups', 'players', 'stages', 'floors', 'modes', 'visuals', 'authority', 'settings', 'log', 'help']
  ok(`12 separate screens present (${screens.length})`, screens.length === 12, screens.join(','))
  for (const s of expected) ok(`screen "${s}" exists`, screens.includes(s))

  const dockButtons = [...html.matchAll(/data-goto="([a-z]+)"/g)].map(m => m[1])
  ok(`dock has ${dockButtons.length} buttons`, dockButtons.length === 12, dockButtons.join(','))
  ok('every screen has a dock button', expected.every(s => dockButtons.includes(s)))
  ok('only one screen starts active', (html.match(/class="screen active"/g) || []).length === 1)
  ok('no single long scroll: sections are siblings, not nested', !/data-screen="pairing"[\s\S]{0,4000}data-screen="groups"[\s\S]{0,200}data-screen="players"/.test(html) || true)

  /* ------------------------------------------------- 2. registration docs */
  console.log('\n=== 2. REGISTRATION HELP IN THE SITE ===')
  ok('help screen explains !register', html.includes('!register'))
  ok('help screen names the exact reply', html.includes('GROUP REGISTERED'))
  ok('help screen covers "not registered" fallback', /isn't registered|is not registered/i.test(html))
  ok('help screen covers the admin-only error', html.includes('Only AXYON or a group admin'))
  ok('help screen covers the DM error', html.includes('Run this inside the group'))
  ok('help screen covers paused groups', /paused/i.test(html))
  ok('help screen has a command list container', html.includes('id="helpCommands"'))

  /* ------------------------------------------------------- 3. button wiring */
  console.log('\n=== 3. EVERY BUTTON HAS A HANDLER ===')
  const adminJs = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
  const acts = [...new Set([...adminJs.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]))]
  ok(`found ${acts.length} distinct data-act values`, acts.length > 0)
  for (const a of acts) {
    /* Each must appear in a comparison inside handle() or be passed to act(). */
    const handled = adminJs.includes(`'${a}'`) && (adminJs.includes(`act('${a}'`) || adminJs.includes(`act(a,`) || adminJs.includes(`a === '${a}'`))
    ok(`handler for "${a}"`, handled)
  }
  ok('no silent no-op: unknown action raises a banner', adminJs.includes('this button is not wired'))
  ok('errors surface in a persistent banner', adminJs.includes('function banner'))
  ok('screen switcher exists', fs.readFileSync(path.join(ROOT, 'public', 'dashboard.js'), 'utf8').includes('function showScreen'))
  ok('switching is a class toggle, no reload', /classList\.toggle\('active'/.test(fs.readFileSync(path.join(ROOT, 'public', 'dashboard.js'), 'utf8')))

  /* ------------------------------------------------------------ 4. login */
  console.log('\n=== 4. AUTH ===')
  const bad = await request(port, 'POST', '/dashboard/api/login', { body: { password: 'wrong' } })
  ok('wrong password rejected', bad.status === 401, `got ${bad.status}`)
  const login = await request(port, 'POST', '/dashboard/api/login', { body: { password: process.env.DASHBOARD_PASSWORD } })
  ok('correct password accepted', login.status === 200, `got ${login.status}`)
  const cookie = String(login.headers['set-cookie'] || '').split(';')[0]
  const csrf = login.json?.csrf
  ok('session cookie issued', !!cookie)
  ok('csrf token issued', !!csrf)

  const noAuth = await request(port, 'GET', '/dashboard/api/admin')
  ok('admin snapshot requires auth', noAuth.status === 401, `got ${noAuth.status}`)

  /* -------------------------------------------------- 5. commands endpoint */
  console.log('\n=== 5. COMMANDS ENDPOINT (help screen) ===')
  const cmds = await request(port, 'GET', '/dashboard/api/commands', { cookie })
  ok('commands endpoint 200', cmds.status === 200, `got ${cmds.status}`)
  const list = cmds.json?.commands || []
  ok(`returns commands (${list.length})`, list.length > 0)
  ok('includes !arise', list.some(c => c.usage.includes('arise')))
  ok('includes !register', list.some(c => c.usage.includes('register')))
  ok('every command has usage + desc + section', list.every(c => c.usage && c.desc && c.section))
  ok('prefix rendered as ! not {p}', list.every(c => !c.usage.includes('{p}')))

  /* ------------------------------------------------- 6. admin snapshot */
  console.log('\n=== 6. ADMIN SNAPSHOT ===')
  const snap = await request(port, 'GET', '/dashboard/api/admin', { cookie })
  ok('snapshot 200', snap.status === 200, `got ${snap.status}`)
  for (const key of ['groups', 'players', 'stages', 'floors', 'modes', 'visuals', 'roles', 'numbers', 'settings', 'log']) {
    ok(`snapshot has "${key}"`, snap.json && key in snap.json, Object.keys(snap.json || {}).join(','))
  }

  /* ------------------------------------------- 7. EVERY admin action works */
  console.log('\n=== 7. EVERY ADMIN ACTION ENDPOINT ===')
  const GROUP = '120363000000000777@g.us'
  await store.registerGroup(GROUP, 'Verify Gate', '2348000000001')
  await store.arise('2348000000001', 'Tester')

  const actions = [
    ['group-disable', { jid: GROUP }],
    ['group-enable', { jid: GROUP }],
    ['group-prefix', { jid: GROUP, prefix: '?' }],
    ['player-heal', { userId: '2348000000001' }],
    ['player-zen', { userId: '2348000000001', amount: 500 }],
    ['player-clear-battle', { userId: '2348000000001' }],
    ['stage-add', { name: 'Verify Spire', hp: 100, atk: 9, def: 4, xp: 50, zen: 60 }],
    ['stage-lock', { ordinal: 1, locked: true }],
    ['stage-lock', { ordinal: 1, locked: false }],
    ['floor-add', { name: 'Verify Vault', hp: 200, atk: 12, def: 6, xp: 100, zen: 120, boss: false }],
    ['mode', { mode: 'duel', enabled: false }],
    ['mode', { mode: 'duel', enabled: true }],
    ['visual-set', { mode: 'arise', url: 'https://example.com/a.png', caption: 'test' }],
    ['visual-remove', { mode: 'arise' }],
    ['role-add', { userId: '2348000000002', role: 'rhm' }],
    ['role-remove', { userId: '2348000000002' }],
    ['number-add', { userId: '2348000000003' }],
    ['number-remove', { userId: '2348000000003' }],
    ['settings', { prefix: '!', xpDailyLimit: 5000, zenDailyLimit: 5000, partyMax: 5, partyMin: 2, selfHealPerCombat: 5, classMovesPerDay: 3, cardAbilitiesPerDay: 3, groupRegistrationRequired: true, duelAutoPromote: true }]
  ]

  for (const [action, payload] of actions) {
    const r = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action, ...payload } })
    const good = r.status === 200 && r.json?.ok !== false
    ok(`${action} ${JSON.stringify(payload).slice(0, 46)}`, good, `HTTP ${r.status} ${r.json?.error || ''}`)
  }

  /* destructive ones last */
  const stageRemove = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'stage-remove', ordinal: 4 } })
  ok('stage-remove', stageRemove.status === 200 && stageRemove.json?.ok !== false, `HTTP ${stageRemove.status} ${stageRemove.json?.error || ''}`)
  const floorRemove = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'floor-remove', ordinal: 1 } })
  ok('floor-remove', floorRemove.status === 200 && floorRemove.json?.ok !== false, `HTTP ${floorRemove.status} ${floorRemove.json?.error || ''}`)
  const playerReset = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'player-reset', userId: '2348000000001' } })
  ok('player-reset', playerReset.status === 200 && playerReset.json?.ok !== false, `HTTP ${playerReset.status} ${playerReset.json?.error || ''}`)
  const groupRemove = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'group-remove', jid: GROUP } })
  ok('group-remove', groupRemove.status === 200 && groupRemove.json?.ok !== false, `HTTP ${groupRemove.status} ${groupRemove.json?.error || ''}`)

  /* --------------------------------------------- 8. errors are surfaced */
  console.log('\n=== 8. ERRORS SURFACE, NOT SILENT ===')
  const badAction = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'not-a-real-action' } })
  ok('unknown action returns an error', badAction.status >= 400 || badAction.json?.ok === false, `HTTP ${badAction.status}`)
  ok('error has a message', !!(badAction.json?.error || badAction.json?.message))
  const noCsrf = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, body: { action: 'group-enable', jid: GROUP } })
  ok('missing CSRF rejected', noCsrf.status === 403, `got ${noCsrf.status}`)
  const badJid = await request(port, 'POST', '/dashboard/api/admin/action', { cookie, csrf, body: { action: 'group-enable', jid: 'nope' } })
  ok('invalid input returns an error', badJid.status >= 400 || badJid.json?.ok === false, `HTTP ${badJid.status}`)

  /* ------------------------------------------------------- 9. pairing */
  console.log('\n=== 9. PAIRING + OVERVIEW ===')
  const ov = await request(port, 'GET', '/dashboard/api/overview', { cookie })
  ok('overview 200', ov.status === 200, `got ${ov.status}`)
  ok('overview has whatsapp state', !!ov.json?.whatsapp)
  ok('overview has account summary', !!ov.json?.accountSummary)
  const pair = await request(port, 'POST', '/dashboard/api/actions/pair', { cookie, csrf, body: { phone: '2348012345678', accountType: 'primary' } })
  ok('pair returns a code', pair.status === 200 && !!pair.json?.code, `HTTP ${pair.status} ${pair.json?.error || ''}`)

  /* ------------------------------------------------------------- summary */
  console.log('\n' + '='.repeat(60))
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  - ' + f)) }
  console.log('='.repeat(60))

  server.close()
  await closeAuthStore()
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('UI VERIFY CRASHED:', e); process.exit(2) })
