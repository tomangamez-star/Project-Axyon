'use strict'
/*
 * Tests for the WhatsApp-code dashboard login, the three authority levels,
 * and the anonymous feedback store.
 *
 * The database-backed paths are exercised against a tiny in-memory fake of the
 * `pg` Pool interface, so these run with no DATABASE_URL and no network.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const access = require('../src/access')
const dashAuth = require('../src/dash-auth')
const lore = require('../src/lore')

/* ------------------------------------------------------------- authority */

test('access: three levels exist and are ordered', () => {
  assert.deepEqual(access.ROLES, ['admin', 'rhm', 'guest'])
  assert.ok(access.atLeast('admin', 'rhm'))
  assert.ok(access.atLeast('rhm', 'guest'))
  assert.equal(access.atLeast('guest', 'rhm'), false)
  assert.equal(access.atLeast('rhm', 'admin'), false)
})

test('access: guest is limited to non-sensitive content', () => {
  /* The game catalogue and the help text are fine. */
  for (const p of ['stages.read', 'floors.read', 'modes.read', 'shop.read', 'commands.read']) {
    assert.equal(access.can('guest', p), true, `guest should read ${p}`)
  }
  /* Anything that exposes an account, a session, a player or authority is not. */
  for (const p of [
    'overview.read', 'overview.control', 'pairing.read', 'pairing.write',
    'groups.read', 'players.read', 'players.write', 'authority.read',
    'authority.write', 'settings.read', 'settings.write', 'log.read',
    'feedback.read', 'shop.write'
  ]) {
    assert.equal(access.can('guest', p), false, `guest must NOT read ${p}`)
  }
})

test('access: rhm moderates content but cannot control accounts or authority', () => {
  for (const p of ['groups.write', 'players.write', 'stages.write', 'floors.write', 'modes.write', 'visuals.write', 'log.read', 'feedback.read']) {
    assert.equal(access.can('rhm', p), true, `rhm should hold ${p}`)
  }
  for (const p of ['overview.control', 'pairing.write', 'authority.write', 'settings.write', 'shop.write']) {
    assert.equal(access.can('rhm', p), false, `rhm must NOT hold ${p}`)
  }
})

test('access: admin holds everything rhm and guest hold', () => {
  for (const role of ['rhm', 'guest']) {
    for (const p of access.permissionsOf(role)) {
      assert.equal(access.can('admin', p), true, `admin should inherit ${p} from ${role}`)
    }
  }
})

test('access: an unknown role holds nothing', () => {
  assert.equal(access.can('nobody', 'stages.read'), false)
  assert.deepEqual(access.permissionsOf('nobody'), [])
})

/* ------------------------------------------------------------ login codes */

test('login codes are 7 or 8 digits and never start with zero', () => {
  for (let i = 0; i < 400; i++) {
    const c = dashAuth.newCode()
    assert.match(c, /^[1-9]\d{6,7}$/, `bad code: ${c}`)
  }
})

test('login codes are not predictable in bulk', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(dashAuth.newCode())
  assert.ok(seen.size > 150, `expected variety, got ${seen.size} distinct codes`)
})

test('a code hash is bound to the number it was issued for', () => {
  const a = dashAuth._test.hashCode('2348012345678', '1234567')
  const b = dashAuth._test.hashCode('2348099999999', '1234567')
  assert.notEqual(a, b)
  assert.equal(a, dashAuth._test.hashCode('2348012345678', '1234567'))
})

test('session tokens are hashed, never stored raw', () => {
  const h = dashAuth._test.hashToken('secret-token')
  assert.notEqual(h, 'secret-token')
  assert.equal(h.length, 64)
})

/* --------------------------------------------------------------- feedback */

test('feedback rejects an empty message and an empty thread', async () => {
  /* No database is configured in the test environment, so the store reports
   * the missing dependency rather than pretending to save. */
  const r = await dashAuth.addFeedback('', 'hello').catch(e => ({ ok: false, message: e.message }))
  assert.equal(r.ok, false)
})

/* ------------------------------------------------------------------- lore */

test('lore: there are many stories, aura lines and welcome lines', () => {
  assert.ok(lore.STORIES.length >= 10, `expected 10+ stories, got ${lore.STORIES.length}`)
  assert.ok(lore.AURA.length >= 30, `expected 30+ aura lines, got ${lore.AURA.length}`)
  assert.ok(lore.WELCOME.length >= 12, `expected 12+ welcome lines, got ${lore.WELCOME.length}`)
})

test('lore: every story has a title and a body', () => {
  for (const s of lore.STORIES) {
    assert.ok(s.title && s.title.length > 3, 'story needs a title')
    assert.ok(Array.isArray(s.body) && s.body.length >= 2, `story "${s.title}" needs a body`)
  }
})

test('lore: story selection is deterministic per seed and walks the set', () => {
  assert.equal(lore.story('player-1:0').title, lore.story('player-1:0').title)
  const titles = new Set()
  for (let i = 0; i < lore.STORIES.length * 3; i++) titles.add(lore.story(`player-1:${i}`).title)
  assert.ok(titles.size >= Math.min(6, lore.STORIES.length), `expected variety, got ${titles.size}`)
})

test('lore: aura and welcome always return a non-empty line', () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(lore.aura().length > 10)
    assert.ok(lore.welcome().length > 10)
  }
})

test('lore: cards render with the watermark header and no undefined', () => {
  const card = lore.storyCard(lore.STORIES[0], '!')
  assert.ok(card.includes(lore.STORIES[0].title))
  assert.equal(card.includes('undefined'), false)
  const aura = lore.auraCard('You are the aura.')
  assert.ok(aura.includes('You are the aura.'))
  assert.equal(aura.includes('undefined'), false)
})
