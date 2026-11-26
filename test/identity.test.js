'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveMentionedId, resolveMessageUserId } = require('../src/identity')

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
