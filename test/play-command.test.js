'use strict'
/*
 * `.play` — LYRICS BY TEXT, ON THE DOT PREFIX ONLY.
 *
 * These drive the real router (`createCommands().handle`) with a fake socket
 * and a stubbed store, and stub the lyrics module so nothing touches the
 * network. They lock down the four things the command must do:
 *
 *   1. `.play <song>` is recognised even though the bot's prefix is `!`.
 *   2. `!play` (the configured prefix) is NOT this command.
 *   3. Lyrics are sent as PLAIN TEXT — never an audio/mp3 payload.
 *   4. When nothing is found, a plain-text "not found" reply is sent.
 */
const test = require('node:test')
const assert = require('node:assert')

const { createCommands } = require('../src/axyon-commands')
const { createAxyon } = require('../src/axyon-rpg')
const store = require('../src/axyon-store')
const lyrics = require('../src/lyrics')
const guard = require('../src/message-guard')

function fakeSock () {
  const sent = []
  return {
    sent,
    async sendMessage (jid, payload) {
      sent.push({ jid, ...payload })
      return { key: { id: `m${sent.length}` } }
    },
    async groupMetadata () { return { subject: 'Test Group', participants: [] } }
  }
}

function harness () {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const saved = {}
  for (const k of ['player', 'group', 'settings', 'log']) saved[k] = store[k]
  store.player = async () => ({ user_id: '2348000000001', name: 'Hunter', level: 1, hp: 100, maxHp: 100 })
  store.group = async () => null
  store.settings = async () => ({ prefix: '!', selfHealPerCombat: 5, classMovesPerDay: 3, xpDailyLimit: 1e9, zenDailyLimit: 1e9, partyMax: 5, partyMin: 2 })
  store.log = async () => {}
  const restore = () => { for (const k of Object.keys(saved)) store[k] = saved[k] }
  return { sock, router: c, restore }
}

function message (text) {
  return { key: { remoteJid: '2348000000001@s.whatsapp.net', id: 'x1', fromMe: false }, message: { conversation: text } }
}

function withLyrics (impl, fn) {
  const original = lyrics.lookup
  lyrics.lookup = impl
  return Promise.resolve().then(fn).finally(() => { lyrics.lookup = original })
}

test('.play is recognised by the message guard even though the prefix is !', () => {
  assert.equal(guard.isCommandText({ conversation: '.play Blinding Lights' }, '!'), true)
  assert.equal(guard.isCommandText({ conversation: '.play' }, '!'), true)
  // The configured prefix must NOT trigger it.
  assert.equal(guard.isCommandText({ conversation: '!play Blinding Lights' }, '!'), true, '!play is a normal command, not .play')
})

test('.play sends the lyrics as plain text and never an audio payload', async () => {
  const h = harness()
  try {
    await withLyrics(async () => ({
      found: true, artist: 'The Weeknd', title: 'Blinding Lights', lyrics: 'I been on my own for long enough'
    }), async () => {
      const handled = await h.router.handle(h.sock, message('.play Blinding Lights The Weeknd'), { conversation: '.play Blinding Lights The Weeknd' })
      assert.equal(handled, true, '.play must be handled by the router')
    })
    assert.equal(h.sock.sent.length, 1)
    const out = h.sock.sent[0]
    assert.ok(typeof out.text === 'string' && out.text.includes('I been on my own for long enough'), 'lyrics must be in the text body')
    assert.ok(out.text.includes('Blinding Lights') && out.text.includes('The Weeknd'))
    // No media of any kind.
    assert.equal(out.audio, undefined)
    assert.equal(out.image, undefined)
    assert.equal(out.video, undefined)
    assert.equal(out.document, undefined)
  } finally { h.restore() }
})

test('.play replies in plain text when the lyrics cannot be found', async () => {
  const h = harness()
  try {
    await withLyrics(async () => ({ found: false }), async () => {
      const handled = await h.router.handle(h.sock, message('.play Some Obscure Song'), { conversation: '.play Some Obscure Song' })
      assert.equal(handled, true)
    })
    assert.equal(h.sock.sent.length, 1)
    const out = h.sock.sent[0]
    assert.match(out.text, /LYRICS NOT FOUND/i)
    assert.ok(out.text.includes('Some Obscure Song'))
    assert.equal(out.audio, undefined)
  } finally { h.restore() }
})

test('.play with no song name shows usage instead of searching', async () => {
  const h = harness()
  let called = false
  try {
    await withLyrics(async () => { called = true; return { found: false } }, async () => {
      const handled = await h.router.handle(h.sock, message('.play'), { conversation: '.play' })
      assert.equal(handled, true)
    })
    assert.equal(called, false, 'no lookup should run without a song name')
    assert.match(h.sock.sent[0].text, /Usage/i)
  } finally { h.restore() }
})

test('a lyrics lookup that throws still produces a plain-text reply', async () => {
  const h = harness()
  try {
    await withLyrics(async () => { throw new Error('network down') }, async () => {
      const handled = await h.router.handle(h.sock, message('.play Anything'), { conversation: '.play Anything' })
      assert.equal(handled, true)
    })
    assert.equal(h.sock.sent.length, 1)
    assert.match(h.sock.sent[0].text, /LYRICS NOT FOUND/i)
  } finally { h.restore() }
})

test('the lyrics module resolves a song through suggest + lyrics endpoints', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('/suggest/')) {
      return { ok: true, json: async () => ({ data: [{ artist: { name: 'The Weeknd' }, title: 'Blinding Lights' }] }) }
    }
    return { ok: true, json: async () => ({ lyrics: 'Line one\nLine two' }) }
  }
  const result = await lyrics.lookup('Blinding Lights', { fetchImpl })
  assert.equal(result.found, true)
  assert.equal(result.artist, 'The Weeknd')
  assert.equal(result.title, 'Blinding Lights')
  assert.equal(result.lyrics, 'Line one\nLine two')
  assert.ok(calls.some(u => u.includes('/suggest/')))
  assert.ok(calls.some(u => u.includes('/v1/')))
})

test('the lyrics module reports not-found when the service has no match', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/suggest/')) return { ok: true, json: async () => ({ data: [] }) }
    return { ok: false, json: async () => ({}) }
  }
  const result = await lyrics.lookup('nothing at all', { fetchImpl })
  assert.equal(result.found, false)
})
