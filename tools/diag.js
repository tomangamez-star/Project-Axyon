'use strict'
/* Diagnostic: what does ONE message actually do? */
const { database } = require('../src/auth-store')
const GROUP = '120363000000000001@g.us'
const OWNER = '2348000000001'
process.env.OWNER_NUMBERS = OWNER
const store = require('../src/axyon-store')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { shouldHandleUpsert, resolveButtonId } = require('../src/message-guard')

const log = []
let counting = false
function instrument () {
  const db = database()
  const orig = db.query.bind(db)
  db.query = async (sql, params) => {
    if (counting) log.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 70))
    return orig(sql, params)
  }
}

function makeSock () {
  const sent = []
  let metaCalls = 0
  return {
    sent,
    get metaCalls () { return metaCalls },
    user: { id: `${OWNER}@s.whatsapp.net` },
    async sendMessage (jid, content, opts) { sent.push({ jid, content, opts }); return { key: { id: 'x' } } },
    async relayMessage () { return { key: { id: 'y' } } },
    async groupMetadata () {
      metaCalls++
      await new Promise(r => setTimeout(r, 120)) // simulate a real WhatsApp round trip
      return { subject: 'G', participants: [{ id: `${OWNER}@s.whatsapp.net`, admin: 'admin' }] }
    },
    async groupParticipantsUpdate () { return [] },
    __sendNativeButtons () { return true }
  }
}

function msg (text) {
  return {
    key: { remoteJid: GROUP, participant: `${OWNER}@s.whatsapp.net`, fromMe: true, id: `m-${Math.random()}` },
    pushName: 'AXYON',
    message: { conversation: text }
  }
}

async function main () {
  instrument()
  const logger = { info () {}, warn () {}, error () {}, child () { return logger } }
  const axyon = createAxyon({ logger, sendButtons: () => true })
  const commands = createCommands({ axyon, logger })
  const sock = makeSock()
  await store.ensureSchema()
  await store.registerGroup(GROUP, 'G', OWNER)

  async function deliver (m) {
    const content = m.message
    const prefix = await commands.buildContext(sock, m, content).then(c => c.prefix).catch(() => '!')
    if (!shouldHandleUpsert(content, { fromMe: true, type: 'notify', prefix })) return false
    const button = resolveButtonId(content)
    if (button && await commands.section(sock, m, button)) return true
    return commands.handle(sock, m, content)
  }

  await deliver(msg('!arise'))
  await deliver(msg('!profile'))

  log.length = 0
  const before = sock.metaCalls
  counting = true
  const t = process.hrtime.bigint()
  await deliver(msg('!profile'))
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  counting = false

  console.log(`\nONE "!profile" message in a group:`)
  console.log(`  wall time: ${ms.toFixed(1)} ms`)
  console.log(`  SQL statements: ${log.length}`)
  console.log(`  groupMetadata() network calls: ${sock.metaCalls - before}`)
  console.log('\n  statements in order:')
  log.forEach((s, i) => console.log(`   ${String(i + 1).padStart(2)}. ${s}`))

  const { closeAuthStore } = require('../src/auth-store')
  await closeAuthStore()
}
main().catch(e => { console.error(e); process.exit(2) })
