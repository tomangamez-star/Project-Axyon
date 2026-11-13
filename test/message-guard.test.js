'use strict'
/*
 * MESSAGE GUARD TESTS
 *
 * The first test is the regression test for the reported bug: commands sent
 * from the connected account itself were dropped before the router saw them,
 * because the old guard only admitted a hardcoded list of legacy slash
 * commands. `!arise` was not on that list.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { shouldHandleUpsert, resolveButtonId, isCommandText, ReplyRateLimiter } = require('../src/message-guard')

test('REGRESSION: the connected account can run !arise from its own number', () => {
  assert.equal(shouldHandleUpsert({ conversation: '!arise' }, { fromMe: true, type: 'notify', prefix: '!' }), true)
  assert.equal(shouldHandleUpsert({ extendedTextMessage: { text: '!arise' } }, { fromMe: true, type: 'append', prefix: '!' }), true)
})

test('REGRESSION: every new command reaches the router from the connected account', () => {
  const commands = ['!help', '!profile', '!stages', '!fight 2', '!party create', '!duel @234', '!cards', '!zen', '!top', '!dungeon']
  for (const text of commands) {
    assert.equal(shouldHandleUpsert({ conversation: text }, { fromMe: true, type: 'notify', prefix: '!' }), true, text)
  }
})

test('commands work in DMs as well as groups', () => {
  // The guard is jid-agnostic; the router resolves the jid. Both must pass.
  assert.equal(shouldHandleUpsert({ conversation: '!arise' }, { fromMe: false, type: 'notify', prefix: '!' }), true)
  assert.equal(shouldHandleUpsert({ conversation: '!arise' }, { fromMe: true, type: 'notify', prefix: '!' }), true)
})

test('a custom prefix is honoured', () => {
  assert.equal(shouldHandleUpsert({ conversation: '#arise' }, { fromMe: true, type: 'notify', prefix: '#' }), true)
  assert.equal(shouldHandleUpsert({ conversation: '!arise' }, { fromMe: true, type: 'notify', prefix: '#' }), false)
})

test('the connected account ordinary outgoing chatter is still ignored', () => {
  assert.equal(shouldHandleUpsert({ conversation: 'hello everyone' }, { fromMe: true, type: 'notify', prefix: '!' }), false)
  assert.equal(shouldHandleUpsert({ conversation: 'hello everyone' }, { fromMe: true, type: 'append', prefix: '!' }), false)
})

test('a bare prefix with no command is not a command', () => {
  assert.equal(isCommandText({ conversation: '!' }, '!'), false)
  assert.equal(isCommandText({ conversation: '!   ' }, '!'), false)
  assert.equal(isCommandText({ conversation: '!arise' }, '!'), true)
})

test('legacy slash commands are no longer recognised', () => {
  for (const text of ['/start', '/balance', '/rpg', '/casino', '/daily']) {
    assert.equal(shouldHandleUpsert({ conversation: text }, { fromMe: true, type: 'notify', prefix: '!' }), false, text)
  }
})

test('legacy button ids are no longer recognised', () => {
  const legacy = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"rpg_home"}' } } }
  assert.equal(resolveButtonId(legacy), null)
  assert.equal(shouldHandleUpsert(legacy, { fromMe: true, type: 'notify', prefix: '!' }), false)
})

test('current button ids are recognised from every tap shape', () => {
  assert.equal(resolveButtonId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"ax_b_attack"}' } } }), 'ax_b_attack')
  assert.equal(resolveButtonId({ buttonsResponseMessage: { selectedButtonId: 'ax_profile' } }), 'ax_profile')
  assert.equal(resolveButtonId({ templateButtonReplyMessage: { selectedId: 'ax_help' } }), 'ax_help')
  assert.equal(resolveButtonId({ listResponseMessage: { singleSelectReply: { selectedRowId: 'ax_stages' } } }), 'ax_stages')
})

test('a button tap from the connected account is routed', () => {
  const tap = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"ax_b_attack"}' } } }
  assert.equal(shouldHandleUpsert(tap, { fromMe: true, type: 'notify', prefix: '!' }), true)
})

test('unknown append messages remain ignored', () => {
  assert.equal(shouldHandleUpsert({ conversation: 'ordinary message' }, { fromMe: false, type: 'append', prefix: '!' }), false)
})

test('rate limiter allows three then mutes', () => {
  const rl = new ReplyRateLimiter()
  const m = { key: { remoteJid: '2348000000001@s.whatsapp.net' } }
  assert.equal(rl.check(m).allowed, true)
  assert.equal(rl.check(m).allowed, true)
  assert.equal(rl.check(m).allowed, true)
  const fourth = rl.check(m)
  assert.equal(fourth.allowed, false)
  assert.equal(fourth.warn, true)
})

test('rate limiter is per sender', () => {
  const rl = new ReplyRateLimiter()
  const a = { key: { remoteJid: '2348000000001@s.whatsapp.net' } }
  const b = { key: { remoteJid: '2348000000002@s.whatsapp.net' } }
  rl.check(a); rl.check(a); rl.check(a)
  assert.equal(rl.check(a).allowed, false)
  assert.equal(rl.check(b).allowed, true)
})
