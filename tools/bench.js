'use strict'
/*
 * RESPONSE-TIME BENCHMARK
 *
 * Measures the real cost of one command through the real router, and counts
 * how many SQL statements that single message causes. The query count is the
 * important number: it is what makes the bot feel slow and inconsistent,
 * because every one of them is a network round trip to Postgres.
 *
 * Run: DATABASE_URL=... node tools/bench.js
 */
const { database } = require('../src/auth-store')

const GROUP = '120363000000000001@g.us'
const OWNER = '2348000000001'
const PLAYER = '2348022222222'
process.env.OWNER_NUMBERS = OWNER

const store = require('../src/axyon-store')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { shouldHandleUpsert, resolveButtonId } = require('../src/message-guard')

/* ------------------------------------------------------- query counting */

let queryCount = 0
let queryMs = 0
let counting = false

function instrument () {
  const db = database()
  if (!db || db.__instrumented) return
  const original = db.query.bind(db)
  db.query = async (...args) => {
    if (!counting) return original(...args)
    queryCount++
    const t = process.hrtime.bigint()
    try {
      return await original(...args)
    } finally {
      queryMs += Number(process.hrtime.bigint() - t) / 1e6
    }
  }
  db.__instrumented = true
}

/* ------------------------------------------------------------- fake socket */

function makeSock () {
  const sent = []
  return {
    sent,
    user: { id: `${OWNER}@s.whatsapp.net` },
    async sendMessage (jid, content, opts) {
      sent.push({ jid, content, opts })
      return { key: { id: `s-${sent.length}` } }
    },
    async relayMessage (jid, message, opts) {
      sent.push({ jid, content: { relayed: message }, opts })
      return { key: { id: `r-${sent.length}` } }
    },
    async groupMetadata () {
      return {
        subject: 'Bench Gate',
        participants: [
          { id: `${OWNER}@s.whatsapp.net`, admin: 'admin' },
          { id: `${PLAYER}@s.whatsapp.net`, admin: null }
        ]
      }
    },
    async groupParticipantsUpdate () { return [] },
    __sendNativeButtons (s, j, body, footer, defs, owner) {
      sent.push({ jid: j, content: { buttons: defs, body, footer, owner } })
      return true
    }
  }
}

function msg (from, text, { group = true, fromMe = true } = {}) {
  return {
    key: {
      remoteJid: group ? GROUP : `${from}@s.whatsapp.net`,
      participant: group ? `${from}@s.whatsapp.net` : undefined,
      fromMe,
      id: `m-${Math.random().toString(36).slice(2)}`
    },
    pushName: from === OWNER ? 'AXYON' : 'Hunter',
    message: { conversation: text }
  }
}

/* ------------------------------------------------------------------- main */

async function main () {
  instrument()
  const logger = { info () {}, warn () {}, error () {}, child () { return logger } }
  const axyon = createAxyon({
    logger,
    sendButtons: (s, j, body, footer, defs, owner) => s.__sendNativeButtons(s, j, body, footer, defs, owner)
  })
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
  await store.registerGroup(GROUP, 'Bench Gate', OWNER)
  await deliver(msg(OWNER, '!arise'))
  await deliver(msg(PLAYER, '!arise'))

  const cases = ['!ping', '!profile', '!help', '!stages', '!zen', '!top', '!cards', '!dungeon', '!party view', '!groups']

  console.log('\n=== PER-COMMAND COST (single message, warm) ===')
  console.log('command'.padEnd(16), 'queries'.padStart(8), 'db ms'.padStart(8), 'total ms'.padStart(9))
  const rows = []
  for (const text of cases) {
    /* warm */
    await deliver(msg(OWNER, text))
    queryCount = 0; queryMs = 0
    counting = true
    const t = process.hrtime.bigint()
    await deliver(msg(OWNER, text))
    const total = Number(process.hrtime.bigint() - t) / 1e6
    counting = false
    rows.push({ text, queries: queryCount, dbMs: queryMs, totalMs: total })
    console.log(text.padEnd(16), String(queryCount).padStart(8), queryMs.toFixed(1).padStart(8), total.toFixed(1).padStart(9))
  }

  const avgQ = rows.reduce((a, r) => a + r.queries, 0) / rows.length
  const avgT = rows.reduce((a, r) => a + r.totalMs, 0) / rows.length
  console.log(`\naverage: ${avgQ.toFixed(1)} queries, ${avgT.toFixed(1)} ms per command`)

  /* -------------------------------------------------- repeated-command jitter */
  console.log('\n=== REPEATED COMMAND (20x !profile) ===')
  const times = []
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint()
    await deliver(msg(OWNER, '!profile'))
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  times.sort((a, b) => a - b)
  const p = q => times[Math.min(times.length - 1, Math.floor(times.length * q))]
  console.log(`min ${times[0].toFixed(1)}  p50 ${p(0.5).toFixed(1)}  p95 ${p(0.95).toFixed(1)}  max ${times[times.length - 1].toFixed(1)} ms`)
  console.log(`spread (max-min): ${(times[times.length - 1] - times[0]).toFixed(1)} ms`)

  /* ------------------------------------------------------- burst behaviour */
  console.log('\n=== BURST (10 commands back to back) ===')
  const burstStart = process.hrtime.bigint()
  for (let i = 0; i < 10; i++) await deliver(msg(OWNER, '!ping'))
  const burst = Number(process.hrtime.bigint() - burstStart) / 1e6
  console.log(`10 commands in ${burst.toFixed(1)} ms (${(burst / 10).toFixed(1)} ms each)`)

  console.log('\nJSON ' + JSON.stringify({
    perCommand: rows.map(r => ({ command: r.text, queries: r.queries, dbMs: +r.dbMs.toFixed(1), totalMs: +r.totalMs.toFixed(1) })),
    avgQueries: +avgQ.toFixed(1),
    avgTotalMs: +avgT.toFixed(1),
    repeated: { min: +times[0].toFixed(1), p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), max: +times[times.length - 1].toFixed(1) },
    burst10Ms: +burst.toFixed(1)
  }))

  const { closeAuthStore } = require('../src/auth-store')
  await closeAuthStore()
}

main().catch(e => { console.error('BENCH CRASHED:', e); process.exit(2) })
