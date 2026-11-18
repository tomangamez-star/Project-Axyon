'use strict'
/*
 * MODES, ROOMS, COMBAT DISPLAY AND AI AUTHORITY.
 *
 * These cover the two specs plus the three fixes:
 *   - Groq is the primary AI route, public routes are the fallback
 *   - an AXYON owner is answered with deference, a member is not
 *   - the mode registry keeps the three protected combat modes distinct
 *   - room states, privacy, capacity and duplicate joins are enforced
 *   - HP/PE bars are derived from the real values, never typed
 *   - the dungeon floor ladder is seeded so !floor can actually fight
 */
const test = require('node:test')
const assert = require('node:assert')

const modes = require('../src/axyon-modes')
const display = require('../src/axyon-combat-display')
const ai = require('../src/ai')
const store = require('../src/axyon-store')

/* ------------------------------------------------------------- mode types */

test('modes: the three global participation types exist', () => {
  assert.deepStrictEqual(modes.MODE_TYPE_IDS.sort(), ['multiplayer', 'party', 'solo'])
  assert.strictEqual(modes.modeType('solo').minPlayers, 1)
  assert.strictEqual(modes.modeType('party').minPlayers, 2)
})

test('modes: party capacity defaults to 5 and is adjustable by the operator', () => {
  assert.strictEqual(modes.capacityFor('party'), 5)
  assert.strictEqual(modes.capacityFor('party', 8), 8)
  /* Clamped: a typo cannot open a 10,000-seat room. */
  assert.strictEqual(modes.capacityFor('party', 10000), modes.PARTY_HARD_MAX)
  assert.strictEqual(modes.capacityFor('party', 1), modes.PARTY_MIN)
})

test('modes: the three protected combat modes are distinct and protected', () => {
  const reg = modes.createModeRegistry()
  for (const id of ['normal_battle', 'challenge_battle', 'boss_battle']) {
    assert.ok(reg.isProtected(id), `${id} must be protected`)
    assert.ok(reg.get(id), `${id} must exist`)
  }
  assert.strictEqual(reg.CORE_MODE_IDS.length, 3)
})

test('modes: a custom mode can never shadow a protected core mode', () => {
  const reg = modes.createModeRegistry({
    custom: [{ id: 'normal_battle', name: 'Hijacked', enabled: true }]
  })
  assert.strictEqual(reg.get('normal_battle').name, 'Normal Battle')
  assert.ok(reg.isProtected('normal_battle'))
})

test('modes: guild slots and collaboration are real, enabled modes', () => {
  /*
   * These were placeholders because the spec fixed their position but forbade
   * inventing their rules. The owner has since asked for them to be built, so
   * the contract is now: they exist, they are enabled, they are enterable, and
   * each one points at a defined rule set.
   */
  const reg = modes.createModeRegistry()
  for (const id of ['guild_1', 'guild_2', 'guild_3', 'collab']) {
    const m = reg.get(id)
    assert.ok(m, `${id} must exist in the menu order`)
    assert.strictEqual(m.placeholder, undefined, `${id} must no longer be a placeholder`)
    assert.strictEqual(m.enabled, true, `${id} must be enabled`)
    assert.ok(m.rules, `${id} must name its rule set`)
    const check = reg.canEnter(id)
    assert.strictEqual(check.ok, true, `${id} must be enterable`)
  }
})

test('modes: menu order matches the spec', () => {
  const reg = modes.createModeRegistry()
  const ids = reg.ordered().map(m => m.id)
  assert.deepStrictEqual(ids.slice(0, 10), modes.MENU_ORDER)
})

test('modes: an unknown mode is refused, not silently allowed', () => {
  const reg = modes.createModeRegistry()
  const check = reg.canEnter('does_not_exist')
  assert.strictEqual(check.ok, false)
  assert.strictEqual(check.reason, 'unknown')
})

/* ------------------------------------------------------------ room states */

test('rooms: a completed room cannot return to active', () => {
  assert.strictEqual(modes.canTransition('completed', 'active'), false)
  assert.strictEqual(modes.canTransition('cancelled', 'active'), false)
  assert.strictEqual(modes.canTransition('expired', 'active'), false)
})

test('rooms: the legal lifecycle transitions are allowed', () => {
  assert.strictEqual(modes.canTransition('waiting', 'ready'), true)
  assert.strictEqual(modes.canTransition('ready', 'active'), true)
  assert.strictEqual(modes.canTransition('active', 'paused'), true)
  assert.strictEqual(modes.canTransition('paused', 'active'), true)
  assert.strictEqual(modes.canTransition('active', 'completed'), true)
})

test('rooms: capacity is enforced', () => {
  const room = { status: 'waiting', privacy: 'public', capacity: 2, participants: [{ userId: 'a' }, { userId: 'b' }] }
  const check = modes.canJoin(room, 'c')
  assert.strictEqual(check.ok, false)
  assert.strictEqual(check.reason, 'full')
})

test('rooms: a player cannot join the same room twice', () => {
  const room = { status: 'waiting', privacy: 'public', capacity: 5, participants: [{ userId: 'a' }] }
  const check = modes.canJoin(room, 'a')
  assert.strictEqual(check.ok, false)
  assert.strictEqual(check.reason, 'duplicate')
})

test('rooms: a private room refuses a stranger who guesses the key', () => {
  const room = { status: 'waiting', privacy: 'private', capacity: 5, owner_id: 'owner', participants: [{ userId: 'owner' }] }
  const check = modes.canJoin(room, 'stranger')
  assert.strictEqual(check.ok, false)
  assert.strictEqual(check.reason, 'private')
})

test('rooms: a private room admits an invited player', () => {
  const room = { status: 'waiting', privacy: 'private', capacity: 5, owner_id: 'owner', participants: [{ userId: 'owner' }], invited: ['guest'] }
  assert.strictEqual(modes.canJoin(room, 'guest').ok, true)
})

test('rooms: an active room refuses new joins', () => {
  const room = { status: 'active', privacy: 'public', capacity: 5, participants: [{ userId: 'a' }] }
  assert.strictEqual(modes.canJoin(room, 'b').reason, 'active')
})

test('rooms: readiness follows the participation minimum', () => {
  assert.strictEqual(modes.isReady({ participation: 'solo', capacity: 1, participants: [{ userId: 'a' }] }), true)
  assert.strictEqual(modes.isReady({ participation: 'party', capacity: 5, participants: [{ userId: 'a' }] }), false)
  assert.strictEqual(modes.isReady({ participation: 'party', capacity: 5, participants: [{ userId: 'a' }, { userId: 'b' }] }), true)
})

test('rooms: only the leader or AXYON may manage a room', () => {
  const room = { owner_id: 'leader' }
  assert.strictEqual(modes.canManage(room, 'leader', {}), true)
  assert.strictEqual(modes.canManage(room, 'stranger', {}), false)
  assert.strictEqual(modes.canManage(room, 'stranger', { axyon: true }), true)
})

test('rooms: participant helpers never mutate the input', () => {
  const room = { participants: [{ userId: 'a' }] }
  const added = modes.addParticipant(room, 'b')
  assert.strictEqual(room.participants.length, 1)
  assert.strictEqual(added.length, 2)
  const removed = modes.removeParticipant(room, 'a')
  assert.strictEqual(room.participants.length, 1)
  assert.strictEqual(removed.length, 0)
})

/* --------------------------------------------------------- combat display */

test('display: the bar is 20 segments and derived from the real ratio', () => {
  const full = display.bar(550, 550)
  assert.strictEqual(full, '[' + '\u2588'.repeat(20) + ']')
  const half = display.bar(275, 550)
  assert.strictEqual(half, '[' + '\u2588'.repeat(10) + '\u2591'.repeat(10) + ']')
  const empty = display.bar(0, 550)
  assert.strictEqual(empty, '[' + '\u2591'.repeat(20) + ']')
})

test('display: a combatant that lost HP never shows a full bar', () => {
  const bar = display.bar(520, 550)
  assert.ok(bar.includes('\u2591'), 'a damaged combatant must show empty segments')
  assert.notStrictEqual(bar, display.bar(550, 550))
})

test('display: percentage rounds the way the spec examples do', () => {
  assert.strictEqual(display.percent(520, 550), 95)
  assert.strictEqual(display.percent(275, 550), 50)
  assert.strictEqual(display.percent(55, 550), 10)
  assert.strictEqual(display.percent(0, 550), 0)
})

test('display: a zero maximum does not produce NaN', () => {
  assert.strictEqual(display.percent(10, 0), 0)
  assert.ok(!display.bar(10, 0).includes('NaN'))
})

test('display: the exact numbers agree with the bar', () => {
  const line = display.hpLine(520, 550)
  assert.strictEqual(line, '520 / 550 HP  (95%)')
  const pe = display.peLine(135, 145)
  assert.strictEqual(pe, '135 / 145 PE  (93%)')
})

test('display: class move counters are independent', () => {
  const t = display.usageTracker({
    moves: [
      { name: 'Shadow Strike', used: 1, limit: 3 },
      { name: 'Phantom Break', used: 0, limit: 3 },
      { name: "Monarch's Wrath", used: 0, limit: 3 }
    ]
  })
  assert.ok(t.includes('Shadow Strike: 1/3'))
  assert.ok(t.includes('Phantom Break: 0/3'))
  assert.ok(t.includes("Monarch's Wrath: 0/3"))
})

test('display: self-healing shows used and remaining out of 5', () => {
  const t = display.usageTracker({ heals: { used: 1, limit: 5 } })
  assert.ok(t.includes('Used: 1/5'))
  assert.ok(t.includes('Remaining: 4'))
})

test('display: an enemy panel shows abilities, never a player card', () => {
  const panel = display.combatantPanel({
    name: 'Shadow Beast', type: 'MONSTER', rank: 'MASTER', level: 42, grade: 4,
    hp: 460, maxHp: 460, pe: 120, maxPe: 120, atk: 55, def: 20, spd: 32, crit: 5,
    abilities: ['Shadow Claw', 'Dark Roar', 'Beast Rampage']
  }, 'enemy')
  assert.ok(panel.includes('MONSTER'))
  assert.ok(panel.includes('Shadow Claw'))
  assert.ok(!panel.includes('EQUIPPED CARD'), 'a monster must not be given a player card')
})

test('display: a basic attack does not claim blocked damage or healing', () => {
  const block = display.actionBlock({
    round: 1, attacker: 'Lil Clutch', action: 'Basic Attack', type: 'basic attack',
    target: 'Shadow Beast', baseDamage: 65, finalDamage: 45
  })
  assert.ok(block.includes('Final Damage: 45'))
  assert.ok(!block.includes('Damage Blocked'), 'a basic attack blocks nothing')
  assert.ok(!block.includes('Healing'), 'a basic attack heals nothing')
})

test('display: the full frame carries the AXYN CORE identity top and bottom', () => {
  const frame = display.battleFrame({
    round: 1, location: 'SHADOW ARENA', mode: 'NORMAL BATTLE', turn: 'Lil Clutch',
    player: { name: 'Lil Clutch', hp: 520, maxHp: 550, pe: 145, maxPe: 145 },
    enemy: { name: 'Shadow Beast', type: 'MONSTER', hp: 415, maxHp: 460, pe: 120, maxPe: 120 }
  })
  assert.ok(frame.startsWith('\u256d'))
  assert.ok(frame.includes('AXYN CORE'))
  assert.ok(frame.includes('ARCHITECT SYSTEM'))
  assert.ok(frame.includes('ROUND 01'))
  assert.ok(frame.includes('520 / 550 HP'))
  assert.ok(frame.includes('415 / 460 HP'))
})

/* ------------------------------------------------------------ AI authority */

test('ai: the owner prompt grants deference and the member prompt does not', () => {
  const owner = ai.authorityBlock('owner')
  const member = ai.authorityBlock('member')
  assert.ok(owner.includes('AXYON'))
  assert.ok(owner.includes('CONFIGURED AXYON OWNER/ADMIN'))
  assert.ok(member.includes('GROUP MEMBER'))
  assert.ok(!member.includes('absolute authority'))
  assert.notStrictEqual(owner, member)
})

test('ai: an unknown authority level falls back to member, never owner', () => {
  const block = ai.authorityBlock('superuser')
  assert.ok(block.includes('GROUP MEMBER'))
})

test('ai: the system prompt embeds the authority block for the asker', () => {
  const owner = ai.buildSystemPrompt({ commands: [], authority: 'owner' })
  const member = ai.buildSystemPrompt({ commands: [], authority: 'member' })
  assert.ok(owner.includes('CONFIGURED AXYON OWNER/ADMIN'))
  assert.ok(!member.includes('CONFIGURED AXYON OWNER/ADMIN'))
})

test('ai: a command explanation reaches the prompt when the registry has one', () => {
  const prompt = ai.buildSystemPrompt({
    commands: [{ name: 'fight', section: 'battle', usage: '{p}duel', desc: 'Fight.', help: 'Enter a stage and trade blows.' }],
    authority: 'member'
  })
  assert.ok(prompt.includes('Enter a stage and trade blows.'))
})

/* ------------------------------------------------------- dungeon seeding */

test('dungeon: the floor ladder is seeded so !floor has something to fight', () => {
  assert.ok(Array.isArray(store.ORIGINAL_FLOORS))
  assert.ok(store.ORIGINAL_FLOORS.length >= 3, 'the dungeon must ship with real floors')
  for (const f of store.ORIGINAL_FLOORS) {
    assert.ok(f.hp > 0 && f.atk > 0 && f.xp > 0, `${f.name} must be a real fight`)
  }
  assert.ok(store.ORIGINAL_FLOORS.some(f => f.boss), 'the ladder must end in a boss')
})

test('dungeon: floors are ordered and uniquely keyed', () => {
  const keys = store.ORIGINAL_FLOORS.map(f => f.key)
  assert.strictEqual(new Set(keys).size, keys.length)
  const ordinals = store.ORIGINAL_FLOORS.map(f => f.ordinal)
  assert.deepStrictEqual(ordinals, [...ordinals].sort((a, b) => a - b))
})

test('ai: Architect prompt allows normal conversation with a confident playful persona', () => {
  const prompt = ai.buildSystemPrompt({ commands: [], authority: 'member' })
  assert.match(prompt, /normal conversation/i)
  assert.match(prompt, /playfully egotistical/i)
  assert.match(prompt, /Do not infer AXYON authority from WhatsApp group-admin status/i)
})

test('ai: AI_API alone configures the OpenAI-compatible fallback key and endpoint', () => {
  const old = {
    api: process.env.AI_API,
    apiUrl: process.env.AI_API_URL,
    apiKey: process.env.AI_API_KEY
  }
  process.env.AI_API = 'test-api-key'
  delete process.env.AI_API_URL
  delete process.env.AI_API_KEY
  try {
    const cfg = ai.createAI({}).config()
    assert.strictEqual(cfg.apiUrl, 'https://api.openai.com/v1/chat/completions')
    assert.strictEqual(cfg.apiKey, 'test-api-key')
  } finally {
    if (old.api === undefined) delete process.env.AI_API; else process.env.AI_API = old.api
    if (old.apiUrl === undefined) delete process.env.AI_API_URL; else process.env.AI_API_URL = old.apiUrl
    if (old.apiKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = old.apiKey
  }
})
