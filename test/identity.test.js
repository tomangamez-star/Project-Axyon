'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveMentionedId } = require('../src/identity')

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
