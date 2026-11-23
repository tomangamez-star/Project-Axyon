'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const adventure = require('../src/axyon-adventure')

test('adventure directory exposes the five requested modes and participant caps', () => {
  assert.deepEqual(Object.keys(adventure.MODES), ['solo', 'multiplayer', 'guild', 'duel', 'abyss'])
  assert.equal(adventure.MODES.solo.maxPlayers, 1)
  assert.equal(adventure.MODES.multiplayer.maxPlayers, 3)
  assert.equal(adventure.MODES.guild.maxPlayers, 5)
  assert.equal(adventure.MODES.duel.maxPlayers, 2)
  assert.equal(adventure.MODES.abyss.maxPlayers, 5)
})

test('mode parser is case-insensitive and rejects unknown modes', () => {
  assert.equal(adventure.cleanMode(' Multiplayer '), 'multiplayer')
  assert.equal(adventure.cleanMode('party'), 'multiplayer')
  assert.equal(adventure.cleanMode('ABYSS'), 'abyss')
  assert.equal(adventure.cleanMode('raid'), null)
})

test('save-code mode naming keeps the Party-facing multiplayer format', () => {
  assert.equal(adventure.codeMode('multiplayer'), 'PARTY')
  for (const mode of ['solo', 'guild', 'duel', 'abyss']) assert.equal(adventure.codeMode(mode), mode.toUpperCase())
})

test('generated save codes are six uppercase hex characters with the correct mode prefix', () => {
  for (const [mode, prefix] of [['solo', 'AX-SOLO'], ['multiplayer', 'AX-PARTY'], ['guild', 'AX-GUILD'], ['duel', 'AX-DUEL'], ['abyss', 'AX-ABYSS']]) {
    assert.match(adventure.makeCode(mode), new RegExp(`^${prefix}-[A-F0-9]{6}$`))
  }
})
