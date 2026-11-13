'use strict'
/*
 * FLOOD CONTROL SCOPING
 *
 * The operator reported the "easy there" warning firing in every chat and
 * group, including on normal conversation. These tests pin down the exact
 * conditions under which it may and may not fire.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { ReplyRateLimiter } = require('../src/message-guard')

const msg = (chat, sender, fromMe = false) => ({
  key: { remoteJid: chat, participant: `${sender}@s.whatsapp.net`, fromMe }
})

test('normal conversation never warns', () => {
  const rl = new ReplyRateLimiter()
  for (let i = 0; i < 5; i++) {
    const r = rl.check(msg('120363000000000001@g.us', `23480000000${i}`))
    assert.equal(r.allowed, true, `message ${i} should be allowed`)
    assert.equal(r.warn, false)
  }
})

test('the bot\'s own messages are never counted and never warned', () => {
  const rl = new ReplyRateLimiter()
  for (let i = 0; i < 20; i++) {
    const r = rl.check(msg('120363000000000001@g.us', '2349999999999', true))
    assert.equal(r.allowed, true)
    assert.equal(r.warn, false)
  }
})

test('a mute in one group does not leak into another group', () => {
  const rl = new ReplyRateLimiter()
  const sender = '2348000000001'
  for (let i = 0; i < 7; i++) rl.check(msg('groupA@g.us', sender))
  const other = rl.check(msg('groupB@g.us', sender))
  assert.equal(other.allowed, true, 'a different group must be unaffected')
  assert.equal(other.warn, false)
})

test('a mute in a group does not leak into a DM', () => {
  const rl = new ReplyRateLimiter()
  const sender = '2348000000001'
  for (let i = 0; i < 7; i++) rl.check(msg('groupA@g.us', sender))
  const dm = rl.check(msg(`${sender}@s.whatsapp.net`, sender))
  assert.equal(dm.allowed, true)
})

test('one user flooding does not mute another user in the same group', () => {
  const rl = new ReplyRateLimiter()
  for (let i = 0; i < 7; i++) rl.check(msg('groupA@g.us', '2348000000001'))
  const innocent = rl.check(msg('groupA@g.us', '2348000000002'))
  assert.equal(innocent.allowed, true)
})

test('a genuine flood is caught, and warns exactly once', () => {
  const rl = new ReplyRateLimiter()
  let warns = 0
  let blocked = 0
  for (let i = 0; i < 12; i++) {
    const r = rl.check(msg('groupA@g.us', '2348000000001'))
    if (r.warn) warns++
    if (!r.allowed) blocked++
  }
  assert.equal(warns, 1, 'the warning must fire once per mute window, not per message')
  assert.ok(blocked >= 1, 'the flood must actually be blocked')
})

test('the allowance is above ordinary human conversation', () => {
  const rl = new ReplyRateLimiter()
  /* Six commands in a row is a fast but normal user; none may be blocked. */
  for (let i = 0; i < 6; i++) {
    assert.equal(rl.check(msg('groupA@g.us', '2348000000001')).allowed, true, `command ${i + 1} of 6`)
  }
})

test('prune drops idle buckets', () => {
  const rl = new ReplyRateLimiter()
  rl.check(msg('groupA@g.us', '2348000000001'))
  assert.equal(rl.users.size, 1)
  rl.prune(Date.now() + 10 * 60 * 1000)
  assert.equal(rl.users.size, 0)
})
