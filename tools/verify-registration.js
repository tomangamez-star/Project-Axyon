'use strict'
/*
 * REGISTRATION FLOW VERIFICATION
 *
 * Drives the REAL command router with real messages and asserts the exact
 * replies. Covers the whole journey a user actually walks:
 *   unregistered group -> !register -> !ping -> !arise -> !profile
 * plus the two failure paths the help screen documents.
 */
const { database, closeAuthStore } = require('../src/auth-store')

const OWNER = '2348000000001'
const MEMBER = '2348000000009'
const GROUP = '120363000000000888@g.us'
const DM = `${MEMBER}@s.whatsapp.net`
process.env.OWNER_NUMBERS = OWNER

const store = require('../src/axyon-store')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { shouldHandleUpsert, resolveButtonId } = require('../src/message-guard')

let pass = 0
let fail = 0
const failures = []
function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) } else { fail++; failures.push(name + (detail ? ` \u2014 ${detail}` : '')); console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`) }
}

function makeSock (adminIds = [OWNER]) {
  const sent = []
  return {
    sent,
    user: { id: `${OWNER}@s.whatsapp.net` },
    last () { return sent[sent.length - 1] },
    text () { const l = this.last(); return l ? (l.content.text || l.content.caption || '') : '' },
    async sendMessage (jid, content, opts) { sent.push({ jid, content, opts }); return { key: { id: `s${sent.length}` } } },
    async relayMessage (jid, content, opts) { sent.push({ jid, content, opts }); return { key: { id: `r${sent.length}` } } },
    async groupMetadata () {
      return { subject: 'Gate', participants: adminIds.map(id => ({ id: `${id}@s.whatsapp.net`, admin: 'admin' })) }
    },
    async groupParticipantsUpdate () { return [] },
    __sendNativeButtons (s, j, body, footer, defs) { sent.push({ jid: j, content: { text: body, buttons: defs } }); return true }
  }
}

function msg (from, text, { group = true, fromMe = true } = {}) {
  return {
    key: { remoteJid: group ? GROUP : DM, participant: group ? `${from}@s.whatsapp.net` : undefined, fromMe, id: `m${Math.random()}` },
    pushName: from === OWNER ? 'AXYON' : 'Hunter',
    message: { conversation: text }
  }
}

async function main () {
  const logger = { info () {}, warn () {}, error () {}, child () { return logger } }
  const axyon = createAxyon({ logger, sendButtons: (s, j, b, f, d) => s.__sendNativeButtons(s, j, b, f, d) })
  const commands = createCommands({ axyon, logger })
  const sock = makeSock()

  async function deliver (m, type = 'notify') {
    const content = m.message
    const prefix = await commands.buildContext(sock, m, content).then(c => c.prefix).catch(() => '!')
    if (!shouldHandleUpsert(content, { fromMe: !!m.key.fromMe, type, prefix })) return false
    const button = resolveButtonId(content)
    if (button && await commands.section(sock, m, button)) return true
    return commands.handle(sock, m, content)
  }

  await store.ensureSchema()
  await store.setSetting('groupRegistrationRequired', true)

  /* ------------------------------------------- 1. unregistered group */
  console.log('\n=== 1. UNREGISTERED GROUP ===')
  sock.sent.length = 0
  await deliver(msg(MEMBER, '!ping'))
  ok('a command in an unregistered group gets a reply (not silence)', sock.sent.length === 1, `${sock.sent.length} replies`)
  ok('reply says the group is not registered', /NOT REGISTERED/i.test(sock.text()), sock.text().slice(0, 80))
  ok('reply tells them to run !register', /!register/.test(sock.text()))

  sock.sent.length = 0
  await deliver(msg(MEMBER, 'just chatting here'))
  ok('ordinary chat in an unregistered group stays silent', sock.sent.length === 0, `${sock.sent.length} replies`)

  /* ------------------------------------------- 2. member cannot register */
  console.log('\n=== 2. NON-ADMIN CANNOT REGISTER ===')
  sock.sent.length = 0
  await deliver(msg(MEMBER, '!register'))
  ok('non-admin is refused', /Only AXYON or a group admin/i.test(sock.text()), sock.text().slice(0, 90))
  ok('group still unregistered', (await store.group(GROUP)) === null)

  /* ------------------------------------------- 3. admin registers */
  console.log('\n=== 3. ADMIN REGISTERS ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!register Verify Gate'))
  const reg = sock.text()
  ok('registration replies', sock.sent.length >= 1)
  ok('reply confirms GROUP REGISTERED', /GROUP REGISTERED/i.test(reg), reg.slice(0, 100))
  ok('reply carries the AXYN CORE watermark', /AXYN CORE/.test(reg))
  ok('reply names the group', /Verify Gate/.test(reg))
  const row = await store.group(GROUP)
  ok('group row exists in the database', !!row)
  ok('group is enabled', row && row.enabled === true)
  ok('group name stored', row && row.name === 'Verify Gate')

  /* ------------------------------------------- 4. commands now work */
  console.log('\n=== 4. COMMANDS WORK AFTER REGISTRATION ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!ping'))
  ok('!ping replies', sock.sent.length === 1)
  ok('!ping says Pong', /Pong/i.test(sock.text()), sock.text().slice(0, 60))

  sock.sent.length = 0
  await deliver(msg(MEMBER, '!arise'))
  ok('!arise replies', sock.sent.length >= 1)
  const p = await store.player(MEMBER)
  ok('!arise created the player row', !!p)
  ok('new player starts at rank E', p && p.rank === 'E', p && p.rank)
  ok('new player starts at level 1', p && p.level === 1, p && p.level)

  sock.sent.length = 0
  await deliver(msg(MEMBER, '!profile'))
  ok('!profile replies after arise', sock.sent.length >= 1)
  ok('!profile shows the hunter', /Hunter|E\b|Lv|LEVEL/i.test(sock.text()), sock.text().slice(0, 80))

  /* ------------------------------------------- 5. DM path */
  console.log('\n=== 5. DIRECT MESSAGE ===')
  sock.sent.length = 0
  await deliver(msg(MEMBER, '!ping', { group: false }))
  ok('!ping works in a DM', sock.sent.length === 1, `${sock.sent.length} replies`)
  ok('DM reply says Pong', /Pong/i.test(sock.text()))

  sock.sent.length = 0
  await deliver(msg(MEMBER, '!register', { group: false }))
  ok('!register in a DM explains it must be in a group', /inside the group/i.test(sock.text()), sock.text().slice(0, 90))

  /* ------------------------------------------- 6. fromMe path */
  console.log('\n=== 6. fromMe (connected account) ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!ping', { fromMe: true }))
  ok('fromMe command is handled', sock.sent.length === 1, `${sock.sent.length} replies`)
  sock.sent.length = 0
  await deliver(msg(OWNER, '!ping', { fromMe: false }))
  ok('fromOther command is handled', sock.sent.length === 1, `${sock.sent.length} replies`)

  /* ------------------------------------------- 7. unregister */
  console.log('\n=== 7. UNREGISTER ===')
  sock.sent.length = 0
  await deliver(msg(OWNER, '!unregister'))
  ok('unregister replies', sock.sent.length >= 1)
  ok('group row removed', (await store.group(GROUP)) === null)

  console.log('\n' + '='.repeat(60))
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  - ' + f)) }
  console.log('='.repeat(60))
  await closeAuthStore()
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('REGISTRATION VERIFY CRASHED:', e); process.exit(2) })
