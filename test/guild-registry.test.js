'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCommands } = require('../src/axyon-commands')
const { createAxyon } = require('../src/axyon-rpg')
const store = require('../src/axyon-store')

function harness () {
  const sent = []
  const sock = { sendMessage: async (jid, payload) => { sent.push({ jid, text: payload.text }); return true } }
  const router = createCommands({ axyon: createAxyon({}) })
  return { sent, sock, command: router.BY_NAME.get('guild') }
}

function context (overrides = {}) {
  return {
    userId: '2348000000001', jid: '2348000000001@s.whatsapp.net', prefix: '.',
    auth: { owner: false, axyon: false, rhm: false }, ...overrides
  }
}

async function withStubs (stubs, fn) {
  const originals = {}
  for (const [key, value] of Object.entries(stubs)) {
    originals[key] = store[key]
    store[key] = value
  }
  try { await fn() } finally {
    for (const [key, value] of Object.entries(originals)) store[key] = value
  }
}

test('guild command is registered in the social section and exposes the management flows', () => {
  const { command } = harness()
  assert.ok(command)
  assert.equal(command.section, 'social')
  for (const name of ['create', 'suggest', 'join', 'leave', 'group', 'ungroup', 'leader', 'disband', 'approve', 'reject']) {
    assert.match(command.usage, new RegExp(name))
  }
  for (const name of ['createGuild', 'guild', 'guilds', 'guildForUser', 'guildMembers', 'joinGuild', 'leaveGuild', 'bindGuildGroup', 'transferGuildLeader', 'disbandGuild', 'suggestGuild', 'guildSuggestions', 'resolveGuildSuggestion']) {
    assert.equal(typeof store[name], 'function', `${name} must be exported by the persistent store`)
  }
})

test('guild creation is owner-only', async () => {
  const { command, sent, sock } = harness()
  await command.handler(sock, {}, context(), ['create', 'Test', '|', 'TEST'], {})
  assert.match(sent[0].text, /AXYON OWNER ONLY/)
})

test('players can submit guild suggestions without owner privileges', async () => {
  const { command, sent, sock } = harness()
  await withStubs({
    suggestGuild: async input => ({ ok: true, suggestion: { id: 7, ...input } }),
    log: async () => true
  }, async () => {
    await command.handler(sock, {}, context(), ['suggest', 'Night', '|', 'NITE', '|', 'A test guild'], {})
  })
  assert.match(sent[0].text, /GUILD SUGGESTION SENT/)
  assert.match(sent[0].text, /#7/)
})

test('owner can bind a guild only from a registered active group', async () => {
  const { command, sent, sock } = harness()
  await withStubs({
    group: async () => ({ status: 'ACTIVE' }),
    guild: async () => ({ id: 3, name: 'Night', tag: 'NITE' }),
    bindGuildGroup: async () => ({ ok: true }),
    log: async () => true
  }, async () => {
    await command.handler(sock, {}, context({
      jid: '120363000000000000@g.us',
      auth: { owner: true, axyon: true, rhm: true }
    }), ['group', '3'], {})
  })
  assert.match(sent[0].text, /GUILD LINKED/)
})

test('guild group binding refuses unregistered group chats', async () => {
  const { command, sent, sock } = harness()
  await withStubs({ group: async () => null }, async () => {
    await command.handler(sock, {}, context({
      jid: '120363000000000000@g.us',
      auth: { owner: true, axyon: true, rhm: true }
    }), ['group', '3'], {})
  })
  assert.match(sent[0].text, /Register this WhatsApp group/)
})
