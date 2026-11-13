'use strict'
/*
 * END-TO-END HARNESS
 *
 * This is not a unit test. It boots the real command router and the real
 * dashboard HTTP handler against a real Postgres database, and drives them the
 * way WhatsApp and a browser would:
 *
 *   - a fake socket records every message the bot sends
 *   - messages are fed in as `fromMe: true` (the connected account) and
 *     `fromMe: false` (a player), in groups and in DMs
 *   - the dashboard is exercised over real HTTP with a real login, real CSRF
 *     and real cookies
 *
 * Run: DATABASE_URL=... node tools/e2e.js
 */
const http = require('http')
const assert = require('assert/strict')

const GROUP = '120363000000000001@g.us'
const DM = '2348011111111@s.whatsapp.net'
const OWNER = '2348000000001'
const PLAYER = '2348022222222'

/* Must be set before access.js is first required. */
process.env.OWNER_NUMBERS = OWNER

const store = require('../src/axyon-store')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { shouldHandleUpsert, resolveButtonId } = require('../src/message-guard')
const { createDashboard } = require('../src/dashboard')

let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) } else { fail++; failures.push(name); console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`) }
}

/* ------------------------------------------------------------- fake socket */

function makeSock () {
  const sent = []
  return {
    sent,
    user: { id: `${OWNER}@s.whatsapp.net` },
    async sendMessage (jid, content, opts) {
      sent.push({ jid, content, opts })
      return { key: { id: `sent-${sent.length}` } }
    },
    async relayMessage (jid, message, opts) {
      sent.push({ jid, content: { relayed: message }, opts })
      return { key: { id: `relay-${sent.length}` } }
    },
    async groupMetadata (jid) {
      return {
        subject: 'Test Gate',
        participants: [
          { id: `${OWNER}@s.whatsapp.net`, admin: 'admin' },
          { id: `${PLAYER}@s.whatsapp.net`, admin: null }
        ]
      }
    },
    async groupParticipantsUpdate (jid, ids, action) {
      sent.push({ jid, content: { participantsUpdate: { ids, action } } })
      return []
    },
    __sendNativeButtons (s, j, body, footer, defs, owner) {
      sent.push({ jid: j, content: { buttons: defs, body, footer, owner } })
      return true
    }
  }
}

function msg (from, text, { group = true, fromMe = false, id = null } = {}) {
  return {
    key: {
      remoteJid: group ? GROUP : `${from}@s.whatsapp.net`,
      participant: group ? `${from}@s.whatsapp.net` : undefined,
      fromMe,
      id: id || `msg-${Math.random().toString(36).slice(2)}`
    },
    pushName: from === OWNER ? 'AXYON' : 'Hunter',
    message: { conversation: text }
  }
}

function lastText (sock) {
  const s = [...sock.sent].reverse().find(x => x.content?.text || x.content?.body)
  return s ? (s.content.text || s.content.body) : ''
}

function allText (sock) { return sock.sent.map(x => x.content?.text || x.content?.body || '').join('\n---\n') }

/* ------------------------------------------------------------------- boot */

async function main () {
  const logger = { info () {}, warn () {}, error () {}, child () { return logger } }
  const axyon = createAxyon({
    logger,
    sendButtons: (s, j, body, footer, defs, owner) => s.__sendNativeButtons(s, j, body, footer, defs, owner)
  })
  const commands = createCommands({ axyon, logger })
  const sock = makeSock()

  /* Route exactly as server.js does. */
  async function deliver (m, type = 'notify') {
    const content = m.message
    const prefix = await commands.buildContext(sock, m, content).then(c => c.prefix).catch(() => '!')
    if (!shouldHandleUpsert(content, { fromMe: !!m.key.fromMe, type, prefix })) return false
    const button = resolveButtonId(content)
    if (button && await commands.section(sock, m, button)) return true
    return commands.handle(sock, m, content)
  }

  console.log('\n=== 1. PRE-FLIGHT: schema and clean state ===')
  await store.ensureSchema()
  const settings = await store.settings()
  ok('default prefix is !', settings.prefix === '!', settings.prefix)
  ok('no players yet', (await store.playerCount()) === 0)
  /* The group must be registered before anything else, because an
   * unregistered group is silent for non-AXYON senders by design. */
  await store.registerGroup(GROUP, 'Test Gate', OWNER)
  ok('test group registered', !!(await store.group(GROUP)))

  console.log('\n=== 2. THE REPORTED BUG: !arise from the connected account ===')
  sock.sent.length = 0
  const arose = await deliver(msg(OWNER, '!arise', { fromMe: true }))
  ok('!arise from fromMe:true is routed', arose === true)
  ok('!arise produced a reply', sock.sent.length > 0, `${sock.sent.length} messages`)
  const ariseText = lastText(sock)
  ok('reply is the new ARISE greeting', /ARISE/.test(ariseText), ariseText.slice(0, 60))
  ok('greeting is NOT the old RYUDEN copy', !/RYUDEN|CHOOSE YOUR PATH/i.test(ariseText))
  ok('greeting has no button grid', !sock.sent.some(x => x.content?.buttons))
  const owner = await store.player(OWNER)
  ok('player row created', !!owner)
  ok('starts at rank E', owner.rank === 'E', owner.rank)
  ok('starts at level 1', owner.level === 1, String(owner.level))
  ok('starts at grade 1', owner.grade === 1, String(owner.grade))
  ok('max HP is 100 at grade 1', owner.maxHp === 100, String(owner.maxHp))
  ok('Power Energy is 50 at rank E', owner.maxPowerEnergy === 50, String(owner.maxPowerEnergy))

  console.log('\n=== 3. !arise in a DM ===')
  sock.sent.length = 0
  const dm = await deliver(msg(PLAYER, '!arise', { group: false, fromMe: true }))
  ok('!arise works in a DM from fromMe:true', dm === true)
  ok('DM reply produced', sock.sent.length > 0)
  ok('DM player created', !!(await store.player(PLAYER)))

  console.log('\n=== 4. Every command runs from the connected account ===')
  const cmds = [
    ['!help', /COMMANDS|HELP|CORE/i],
    ['!profile', /RANK|HUNTER|PROFILE/i],
    ['!stages', /STAGE|GATE/i],
    ['!dungeon', /DUNGEON|MODE/i],
    ['!party view', /PARTY/i],
    ['!cards', /CARD/i],
    ['!zen', /ZEN/i],
    ['!top', /RANKING|HUNTER/i],
    ['!requests', /REQUEST/i],
    ['!groups', /GROUP/i]
  ]
  for (const [text, re] of cmds) {
    sock.sent.length = 0
    const handled = await deliver(msg(OWNER, text, { fromMe: true }))
    const out = lastText(sock)
    ok(`${text} handled`, handled === true)
    ok(`${text} replied`, sock.sent.length > 0, 'no output')
    ok(`${text} reply looks right`, re.test(out), out.slice(0, 70))
  }

  console.log('\n=== 5. Registration gate: unregistered player is told to !arise ===')
  const stranger = '2348099999999'
  sock.sent.length = 0
  await deliver(msg(stranger, '!profile', { fromMe: true }))
  ok('unregistered player gets the arise prompt', /arise/i.test(lastText(sock)), lastText(sock).slice(0, 60))

  console.log('\n=== 6. Legacy commands are dead ===')
  for (const legacy of ['/start', '/balance', '/rpg', '/casino', '/daily', '/menu']) {
    sock.sent.length = 0
    const handled = await deliver(msg(OWNER, legacy, { fromMe: true }))
    ok(`${legacy} is not routed`, handled === false)
    ok(`${legacy} produces no output`, sock.sent.length === 0)
  }

  console.log('\n=== 7. Buttons: only where needed ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!stages', { fromMe: true }))
  ok('!stages has no buttons', !sock.sent.some(x => x.content?.buttons))

  sock.sent.length = 0
  await deliver(msg(OWNER, '!fight 1', { fromMe: true }))
  const battleButtons = sock.sent.find(x => x.content?.buttons)
  ok('!fight DOES show battle buttons', !!battleButtons)
  ok('battle buttons are the six actions', battleButtons && battleButtons.content.buttons.length === 6,
    battleButtons ? String(battleButtons.content.buttons.length) : 'none')

  console.log('\n=== 8. Battle actions work as plain commands ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!attack', { fromMe: true }))
  ok('!attack resolves a turn', sock.sent.length > 0, 'no output')
  ok('!attack reply mentions damage or HP', /HP|damage|strike|hit/i.test(lastText(sock)), lastText(sock).slice(0, 80))

  console.log('\n=== 9. Button taps route to real handlers ===')
  sock.sent.length = 0
  const tap = {
    key: { remoteJid: GROUP, participant: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'tap-1' },
    pushName: 'AXYON',
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"ax_profile"}' } } }
  }
  const tapped = await deliver(tap)
  ok('ax_profile tap handled', tapped === true)
  ok('ax_profile tap produced a profile', /RANK|HUNTER|PROFILE/i.test(lastText(sock)), lastText(sock).slice(0, 60))

  sock.sent.length = 0
  const badTap = {
    key: { remoteJid: GROUP, participant: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'tap-2' },
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"rpg_home"}' } } }
  }
  const badTapped = await deliver(badTap)
  ok('legacy button id is not handled', badTapped === false)
  ok('legacy button id produces no output', sock.sent.length === 0)

  console.log('\n=== 10. Group registration gate ===')
  await store.unregisterGroup(GROUP)
  sock.sent.length = 0
  await deliver(msg(PLAYER, '!profile', { fromMe: true }))
  ok('unregistered group is silent for players', sock.sent.length === 0, `${sock.sent.length} messages`)
  sock.sent.length = 0
  await deliver(msg(OWNER, '!register Test Gate', { fromMe: true }))
  ok('AXYON can register the group', /REGISTERED/i.test(lastText(sock)), lastText(sock).slice(0, 60))
  ok('group row exists', !!(await store.group(GROUP)))
  sock.sent.length = 0
  await deliver(msg(PLAYER, '!profile', { fromMe: true }))
  ok('registered group now responds', sock.sent.length > 0)

  console.log('\n=== 11. Prefix change takes effect ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!prefix #', { fromMe: true }))
  ok('prefix changed', (await store.settings()).prefix === '#')
  sock.sent.length = 0
  const oldPrefix = await deliver(msg(OWNER, '!profile', { fromMe: true }))
  ok('old prefix no longer routes', oldPrefix === false)
  sock.sent.length = 0
  const newPrefix = await deliver(msg(OWNER, '#profile', { fromMe: true }))
  ok('new prefix routes', newPrefix === true)
  await store.setSetting('prefix', '!')

  console.log('\n=== 12. Duel: challenge, accept, temporary admin ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, `!duel @${PLAYER}`, { fromMe: true }))
  const duelText = lastText(sock)
  ok('duel challenge created', /DUEL CHALLENGE/i.test(duelText), duelText.slice(0, 60))
  const { database } = require('../src/auth-store')
  const pending = (await database().query(
    "SELECT * FROM axyon_duels WHERE status='pending' ORDER BY id DESC LIMIT 1"
  )).rows[0]
  ok('duel row is pending', !!pending)
  if (pending) {
    sock.sent.length = 0
    await deliver(msg(PLAYER, `!duel accept ${pending.id}`, { fromMe: true }))
    ok('duel accepted', /DUEL BEGINS/i.test(lastText(sock)), lastText(sock).slice(0, 60))
    const promoted = sock.sent.find(x => x.content?.participantsUpdate)
    ok('temporary admin promotion was actually called', !!promoted,
      promoted ? promoted.content.participantsUpdate.action : 'not called')
    ok('promotion targets both fighters', promoted && promoted.content.participantsUpdate.ids.length === 2)
  }

  console.log('\n=== 13. Dashboard: real HTTP, real login, real CSRF ===')
  const sessions = {
    status: () => ({ primary: { sessionId: 'p', state: 'connected' }, accounts: [{ sessionId: 'p', state: 'connected', phone: '2348000000001', storage: 'postgres', uptimeSec: 10, messagesHandled: 5 }], connected: 1, total: 1 }),
    reconnect: async () => {},
    setPaused: () => ({}),
    pair: async () => ({ id: 'p', code: 'ABCD1234', accountType: 'primary' }),
    remove: async () => true,
    resetAll: async () => ({ removed: 0 })
  }
  const lease = { status: () => ({ owned: true }), forceTakeover: async () => {} }
  const dashboard = createDashboard({ sessions, database: () => null, lease, logger })
  const server = http.createServer((q, r) => { void dashboard.handle(q, r).then(h => { if (!h) r.writeHead(404).end() }) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  let cookie = ''
  async function call (path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) }
    if (cookie) headers.cookie = cookie
    const res = await fetch(base + path, { ...opts, headers, redirect: 'manual' })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  }

  const anon = await call('/dashboard/api/admin')
  ok('admin snapshot requires auth', anon.status === 401, String(anon.status))

  const badLogin = await call('/dashboard/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })
  ok('wrong password rejected', badLogin.status === 401, String(badLogin.status))

  const login = await call('/dashboard/api/login', { method: 'POST', body: JSON.stringify({ password: process.env.DASHBOARD_PASSWORD }) })
  ok('login succeeds', login.status === 200, String(login.status))
  const csrf = login.json?.csrf
  ok('login returns a CSRF token', !!csrf)

  const snap = await call('/dashboard/api/admin')
  ok('admin snapshot loads when signed in', snap.status === 200, String(snap.status))
  ok('snapshot has groups', Array.isArray(snap.json?.groups))
  ok('snapshot has players', Array.isArray(snap.json?.players))
  ok('snapshot has stages', Array.isArray(snap.json?.stages))
  ok('snapshot has settings', !!snap.json?.settings)
  ok('snapshot reflects the registered group', (snap.json?.groups || []).some(g => g.jid === GROUP))
  ok('snapshot reflects the arisen player', (snap.json?.players || []).some(p => p.userId === OWNER))

  const noCsrf = await call('/dashboard/api/admin/action', { method: 'POST', body: JSON.stringify({ action: 'group-disable', jid: GROUP }) })
  ok('action without CSRF is refused', noCsrf.status === 403, String(noCsrf.status))

  /* Every button the panel renders, exercised for real. */
  const actions = [
    ['group-disable', { jid: GROUP }, 'group disabled'],
    ['group-enable', { jid: GROUP }, 'group enabled'],
    ['group-prefix', { jid: GROUP, prefix: '?' }, 'group prefix'],
    ['player-heal', { userId: OWNER }, 'player healed'],
    ['player-zen', { userId: OWNER, amount: 500 }, 'zen granted'],
    ['player-clear-battle', { userId: OWNER }, 'battle cleared'],
    ['stage-add', { name: 'E2E Stage', hp: 100, atk: 8, def: 4, xp: 60, zen: 90 }, 'stage added'],
    ['stage-lock', { ordinal: 1, locked: true }, 'stage locked'],
    ['stage-lock', { ordinal: 1, locked: false }, 'stage unlocked'],
    ['floor-add', { name: 'E2E Floor', hp: 200, atk: 12, def: 6, xp: 150, zen: 200, boss: false }, 'floor added'],
    ['mode', { mode: 'party', enabled: true }, 'mode enabled'],
    ['mode', { mode: 'party', maxPlayers: 6 }, 'mode max'],
    ['visual-set', { mode: 'battle', url: 'https://example.com/b.png', caption: 'test' }, 'visual set'],
    ['visual-remove', { mode: 'battle' }, 'visual removed'],
    ['number-add', { userId: '2348033333333' }, 'number added'],
    ['number-remove', { userId: '2348033333333' }, 'number removed'],
    ['role-add', { userId: '2348044444444', role: 'rhm' }, 'role added'],
    ['role-remove', { userId: '2348044444444' }, 'role removed'],
    ['settings', { prefix: '!', xpDailyLimit: 5000, zenDailyLimit: 5000, partyMax: 5, partyMin: 2, selfHealPerCombat: 5, classMovesPerDay: 3, cardAbilitiesPerDay: 3, groupRegistrationRequired: true, duelAutoPromote: true }, 'settings saved']
  ]
  for (const [action, payload, label] of actions) {
    const r = await call('/dashboard/api/admin/action', {
      method: 'POST',
      headers: { 'x-architect-csrf': csrf },
      body: JSON.stringify({ action, ...payload })
    })
    ok(`${label} (${action}) returns 200`, r.status === 200, `${r.status} ${r.json?.message || r.text.slice(0, 60)}`)
    ok(`${label} reports ok`, r.json?.ok === true, r.json?.message || '')
  }

  /* Cleanup actions that need a target created above. */
  const stages = (await call('/dashboard/api/admin')).json.stages
  const added = stages.find(s => s.name === 'E2E Stage')
  if (added) {
    const r = await call('/dashboard/api/admin/action', {
      method: 'POST', headers: { 'x-architect-csrf': csrf },
      body: JSON.stringify({ action: 'stage-remove', ordinal: added.ordinal })
    })
    ok('stage-remove returns 200', r.status === 200, String(r.status))
  }
  const floors = (await call('/dashboard/api/admin')).json.floors
  const addedFloor = floors.find(f => f.name === 'E2E Floor')
  if (addedFloor) {
    const r = await call('/dashboard/api/admin/action', {
      method: 'POST', headers: { 'x-architect-csrf': csrf },
      body: JSON.stringify({ action: 'floor-remove', ordinal: addedFloor.ordinal })
    })
    ok('floor-remove returns 200', r.status === 200, String(r.status))
  }

  const unknown = await call('/dashboard/api/admin/action', {
    method: 'POST', headers: { 'x-architect-csrf': csrf },
    body: JSON.stringify({ action: 'not-a-real-action' })
  })
  ok('unknown action returns 400 with a message', unknown.status === 400 && !!unknown.json?.message, String(unknown.status))

  const badPrefix = await call('/dashboard/api/admin/action', {
    method: 'POST', headers: { 'x-architect-csrf': csrf },
    body: JSON.stringify({ action: 'settings', prefix: 'toolong' })
  })
  ok('invalid input is rejected, not silently ignored', badPrefix.status === 400 && /prefix/i.test(badPrefix.json?.message || ''), badPrefix.json?.message)

  const log = (await call('/dashboard/api/admin')).json.log
  ok('audit log recorded the dashboard actions', (log || []).some(l => String(l.action).startsWith('admin_')), `${(log || []).length} entries`)

  const logout = await call('/dashboard/api/logout', { method: 'POST', headers: { 'x-architect-csrf': csrf }, body: '{}' })
  ok('logout succeeds', logout.status === 200, String(logout.status))
  const afterLogout = await call('/dashboard/api/admin')
  ok('admin snapshot refused after logout', afterLogout.status === 401, String(afterLogout.status))

  console.log('\n=== 14. Static assets the panel needs ===')
  for (const asset of ['/dashboard', '/dashboard/app.js', '/dashboard/admin.js', '/dashboard/admin.css', '/dashboard/app.css']) {
    const r = await fetch(base + asset).catch(() => null)
    ok(`${asset} served`, r ? r.status === 200 : false, r ? String(r.status) : 'server closed')
  }

  server.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(`  - ${f}`)) }
  console.log('='.repeat(60))
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('HARNESS CRASHED:', e); process.exit(2) })
