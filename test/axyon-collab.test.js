'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const collab = require('../src/axyon-collab')

test('collaboration text is whitespace-normalised, control-safe and bounded', () => {
  assert.equal(collab.clean('  Hello\n\t  AXYON  '), 'Hello AXYON')
  assert.equal(collab.clean('A\u0000B'), 'A B')
  assert.equal(collab.clean('x'.repeat(25), 10), 'x'.repeat(10))
})

test('collaboration group IDs must be WhatsApp group JIDs', () => {
  assert.equal(collab.validGroupJid('120363012345678-123456@g.us'), true)
  assert.equal(collab.validGroupJid('1234567890@s.whatsapp.net'), false)
  assert.equal(collab.validGroupJid('https://chat.whatsapp.com/example'), false)
  assert.equal(collab.validGroupJid(''), false)
})

test('collaboration status transitions enforce the campaign lifecycle', () => {
  assert.equal(collab.canTransition('draft', 'pending'), true)
  assert.equal(collab.canTransition('pending', 'approved'), true)
  assert.equal(collab.canTransition('approved', 'active'), true)
  assert.equal(collab.canTransition('active', 'paused'), true)
  assert.equal(collab.canTransition('paused', 'active'), true)
  assert.equal(collab.canTransition('completed', 'active'), false)
  assert.equal(collab.canTransition('cancelled', 'draft'), false)
  assert.equal(collab.canTransition('unknown', 'active'), false)
})
