'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveMentionedId, resolveMessageUserId } = require('../src/identity')
const store = require('../src/axyon-store')

test('mentioned phone JID resolves to the stored player number', async () => {
  const content = { extendedTextMessage: { contextInfo: { mentionedJid: ['2348012345678@s.whatsapp.net'] } } }
  assert.equal(await resolveMentionedId({}, content), '2348012345678')
})

test('mentioned LID resolves through Baileys phone-number mapping', async () => {
  const content = { extendedTextMessage: { contextInfo: { mentionedJid: ['123456789012345@lid'] } } }
  const sock = { signalRepository: { lidMapping: { getPNForLID: async jid => {
    assert.equal(jid, '123456789012345@lid')
    return '2348012345678@s.whatsapp.net'
  } } } }
  assert.equal(await resolveMentionedId(sock, content), '2348012345678')
})

test('unmapped LID is not mistaken for a stored phone-number player', async () => {
  const content = { extendedTextMessage: { contextInfo: { mentionedJid: ['123456789012345@lid'] } } }
  assert.equal(await resolveMentionedId({}, content), null)
})


test('fromMe DM commands resolve to the connected account, not the chat recipient', async () => {
  const message = { key: { remoteJid: '2348099999999@s.whatsapp.net', fromMe: true } }
  const sock = { user: { id: '2348012345678:17@s.whatsapp.net' } }
  assert.equal(await resolveMessageUserId(sock, message), '2348012345678')
})

test('incoming DM messages still resolve to the other sender, not the connected account', async () => {
  const message = { key: { remoteJid: '2348099999999@s.whatsapp.net', fromMe: false } }
  const sock = { user: { id: '2348012345678@s.whatsapp.net' } }
  assert.equal(await resolveMessageUserId(sock, message), '2348099999999')
})

test('!arise command context for a fromMe DM is keyed to the connected account', async () => {
  const { createAxyon } = require('../src/axyon-rpg')
  const { createCommands } = require('../src/axyon-commands')
  const original = {
    settings: store.settings,
    axyonNumberMode: store.axyonNumberMode,
    roleOf: store.roleOf
  }
  store.settings = async () => ({ prefix: '!' })
  store.axyonNumberMode = async () => null
  store.roleOf = async () => null
  try {
    const sock = { user: { id: '2348012345678@s.whatsapp.net' } }
    const message = {
      key: { remoteJid: '2348099999999@s.whatsapp.net', fromMe: true, id: 'from-me-arise' },
      pushName: 'Architect',
      message: { conversation: '!arise' }
    }
    const commands = createCommands({ axyon: createAxyon({}) })
    const ctx = await commands.buildContext(sock, message, message.message)
    assert.equal(ctx.userId, '2348012345678')
  } finally {
    store.settings = original.settings
    store.axyonNumberMode = original.axyonNumberMode
    store.roleOf = original.roleOf
  }
})

test('fromMe group commands resolve to the connected account even without participant metadata', async () => {
  const message = { key: { remoteJid: '120363000000000001@g.us', fromMe: true } }
  const sock = { user: { id: '2348012345678@s.whatsapp.net' } }
  assert.equal(await resolveMessageUserId(sock, message), '2348012345678')
})

test('fromMe account LID is mapped to its phone-number player key', async () => {
  const message = { key: { remoteJid: '2348099999999@s.whatsapp.net', fromMe: true } }
  const sock = {
    user: { id: '123456789012345@lid' },
    signalRepository: { lidMapping: { getPNForLID: async jid => {
      assert.equal(jid, '123456789012345@lid')
      return '2348012345678@s.whatsapp.net'
    } } }
  }
  assert.equal(await resolveMessageUserId(sock, message), '2348012345678')
})

test('group LID message sender resolves to the registered phone-number key', async () => {
  const message = { key: { remoteJid: 'group@g.us', participant: '123456789012345@lid' } }
  const sock = { signalRepository: { lidMapping: { getPNForLID: async jid => {
    assert.equal(jid, '123456789012345@lid')
    return '2348012345678@s.whatsapp.net'
  } } } }
  assert.equal(await resolveMessageUserId(sock, message), '2348012345678')
  assert.equal(message.key.participantAlt, '2348012345678@s.whatsapp.net')
})

test('message sender prefers a WhatsApp phone JID when both phone and LID are present', async () => {
  const message = { key: {
    remoteJid: 'group@g.us',
    participant: '123456789012345@lid',
    participantAlt: '2348012345678@s.whatsapp.net'
  } }
  assert.equal(await resolveMessageUserId({}, message), '2348012345678')
})


test('owner target resolution accepts a reply to a phone-number message', async () => {
  const content = { extendedTextMessage: { contextInfo: { participant: '2348012345678@s.whatsapp.net' } } }
  const { resolveTargetUserId } = require('../src/identity')
  assert.equal(await resolveTargetUserId({}, content), '2348012345678')
})

test('owner target resolution maps a reply to a LID message', async () => {
  const content = { extendedTextMessage: { contextInfo: { participant: '123456789012345@lid' } } }
  const sock = { signalRepository: { lidMapping: { getPNForLID: async () => '2348012345678@s.whatsapp.net' } } }
  const { resolveTargetUserId } = require('../src/identity')
  assert.equal(await resolveTargetUserId(sock, content), '2348012345678')
})
