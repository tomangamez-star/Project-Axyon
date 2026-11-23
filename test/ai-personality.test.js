'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSystemPrompt } = require('../src/ai')

test('Architect prompt prioritizes natural conversation and avoids canned AI framing', () => {
  const prompt = buildSystemPrompt({ botName: 'Architect', prefix: '!', commands: [] })
  assert.match(prompt, /laid-back/)
  assert.match(prompt, /recent conversation history and quoted-message context/)
  assert.match(prompt, /Do not introduce yourself as an AI/)
  assert.match(prompt, /Never open with "How can I help\?"/)
  assert.match(prompt, /Do not bring up AXYON.*unless the person explicitly asks/)
})
