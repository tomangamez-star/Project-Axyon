'use strict'
/*
 * VERIFY AI ROUTING — exercises the trigger path, not the code.
 *
 * The operator's requirement: the assistant is used by tagging it or replying
 * to its message. This drives the real `isAITrigger` / `aiQuestion` methods on
 * the real WhatsAppConnection class with realistic Baileys message shapes, and
 * asserts the negative cases too — a normal message must NOT wake it.
 */
const assert = require('assert')

let pass = 0
let fail = 0
const failures = []

function ok (name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name} ${detail}`) }
}

/* Pull the class without booting the whole server (which would open a socket). */
const src = require('fs').readFileSync(require('path').join(__dirname, '../src/server.js'), 'utf8')
const start = src.indexOf('class WhatsAppConnection')
const end = src.indexOf('class WhatsAppSessionManager')
const body = src.slice(start, end)

/* Build a minimal harness around the two methods we care about. */
const factory = new Function('aiConfig', `
  const aiConfigRef = { value: aiConfig }
  ${body.replace(/^class WhatsAppConnection/, 'class WhatsAppConnection')}
  return WhatsAppConnection
`)

const aiConfig = { aiEnabled: true }
const WhatsAppConnection = factory(aiConfig)

/* A connection instance without running its constructor (no socket, no DB). */
const conn = Object.create(WhatsAppConnection.prototype)
conn.log = { warn () {}, info () {}, debug () {} }

const BOT = '2348011111111'
const sock = { user: { id: `${BOT}:12@s.whatsapp.net` } }

function textMsg (text, extra = {}) {
  return { conversation: text, ...extra }
}
function extMsg (text, contextInfo = {}) {
  return { extendedTextMessage: { text, contextInfo } }
}

console.log('\n=== 1. @-mention wakes the assistant ===')
ok('mention of the bot number triggers',
  conn.isAITrigger(sock, {}, extMsg('@2348011111111 how do I play a mode?', {
    mentionedJid: [`${BOT}@s.whatsapp.net`]
  })) === true)

ok('mention with a device suffix still matches',
  conn.isAITrigger(sock, {}, extMsg('@2348011111111 hello', {
    mentionedJid: [`${BOT}:12@s.whatsapp.net`]
  })) === true)

console.log('\n=== 2. Replying to the bot wakes the assistant ===')
ok('reply to a bot message triggers',
  conn.isAITrigger(sock, {}, extMsg('what are ranks?', {
    participant: `${BOT}@s.whatsapp.net`
  })) === true)

console.log('\n=== 3. Normal traffic does NOT wake it ===')
ok('plain conversation does not trigger',
  conn.isAITrigger(sock, {}, textMsg('hey guys what is up') ) === false)

ok('a message mentioning someone else does not trigger',
  conn.isAITrigger(sock, {}, extMsg('@2348099999999 look at this', {
    mentionedJid: ['2348099999999@s.whatsapp.net']
  })) === false)

ok('a reply to another user does not trigger',
  conn.isAITrigger(sock, {}, extMsg('agreed', {
    participant: '2348099999999@s.whatsapp.net'
  })) === false)

ok('a command is not treated as an AI question',
  conn.isAITrigger(sock, {}, textMsg('!arise')) === false)

console.log('\n=== 4. Disabled assistant stays silent ===')
aiConfig.aiEnabled = false
ok('disabled: mention does not trigger',
  conn.isAITrigger(sock, {}, extMsg('@2348011111111 hi', {
    mentionedJid: [`${BOT}@s.whatsapp.net`]
  })) === false)
aiConfig.aiEnabled = true

console.log('\n=== 5. The question is cleaned before it reaches the model ===')
ok('the @mention is stripped',
  conn.aiQuestion(extMsg('@2348011111111 how do I play a mode?')) === 'how do I play a mode?',
  conn.aiQuestion(extMsg('@2348011111111 how do I play a mode?')))

ok('extra whitespace is collapsed',
  conn.aiQuestion(extMsg('@2348011111111    what   is   zen  ')) === 'what is zen',
  conn.aiQuestion(extMsg('@2348011111111    what   is   zen  ')))

ok('a bare mention receives a natural greeting prompt',
  /addressed by name or mentioned/i.test(conn.aiQuestion(extMsg('@2348011111111'))))

ok('calling Architect by name triggers',
  conn.isAITrigger(sock, {}, textMsg('Architect, are you there?')) === true)

ok('calling Architect by name is stripped from the question',
  conn.aiQuestion(textMsg('Architect, tell me about the floors')) === 'tell me about the floors')

ok('a reply with a quoted stanza id triggers',
  conn.isAITrigger(sock, {}, extMsg('what now?', { participant: `${BOT}@s.whatsapp.net`, stanzaId: 'quoted-message-1' })) === true)

conn.ownMessageIds = new Set(['native-flow-message-1'])
ok('reply to a tracked native WhatsApp button message triggers',
  conn.isAITrigger(sock, {}, extMsg('I chose option two', { stanzaId: 'native-flow-message-1', quotedMessage: { conversation: 'choose' } })) === true)

console.log('\n=== 6. No socket means no crash ===')
ok('a missing sock.user does not throw',
  (() => { try { conn.isAITrigger({}, {}, textMsg('hi')); return true } catch { return false } })())

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log('FAILURES: ' + failures.join(', ')); process.exit(1) }
