'use strict'
/*
 * GREETINGS — the words Architect uses when someone arrives.
 *
 * These are new. The old build greeted people with "WELCOME TO RYUDEN" and a
 * six-button menu; none of that copy survives. Every greeting here is plain
 * text, framed, and tells a new hunter exactly one thing to do next.
 *
 * A greeting is picked deterministically from the player id, so the same hunter
 * always gets the same line and it never feels like a slot machine.
 */
const T = require('./theme')

const FIRST_LIGHT = [
  'The gate did not open for you. It noticed you.',
  'Something on the other side has been counting the days.',
  'You were not chosen. You were the only one still standing.',
  'The System does not recruit. It records what it cannot ignore.',
  'Every hunter begins as a rumour. You are now one.'
]

const RETURNING = [
  'The System kept your place. It does not do that for everyone.',
  'Your record is intact. Nothing was taken while you were gone.',
  'The gate remembers your footsteps.',
  'You came back. That is the part most people fail.',
  'Your progress held. Continue where you stopped.'
]

const RANK_LINE = {
  E: 'Rank E — the bottom of the ladder, and the only place to start.',
  D: 'Rank D — the gate has started to take you seriously.',
  C: 'Rank C — hunters are beginning to say your name.',
  B: 'Rank B — you are no longer the weakest thing in the room.',
  A: 'Rank A — the System has stopped testing you and started watching you.',
  S: 'Rank S — few reach this. Fewer stay sane here.',
  SS: 'Rank SS — the gates open before you arrive.',
  SSS: 'Rank SSS — you are the reason the gates close.',
  Monarch: 'Monarch — the System answers to you now.'
}

/** Stable small hash so a given player always gets the same greeting. */
function pick (list, seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return list[h % list.length]
}

function creatorsOf (settings) {
  const c = settings?.creators
  return Array.isArray(c) && c.length ? c : ['Lil Clutch', 'Montai']
}

/**
 * First arrival. This is the card a brand-new hunter sees after `!arise`.
 *
 * Layout follows the reference: header with credit line, a block banner, the
 * hunter's name in the display font, a quote, then a framed stat card.
 */
function firstGreeting (player, prefix, settings) {
  const stats = T.frame([
    T.field('📈', 'Level', T.m(player.level)),
    T.field('🏅', 'Rank', T.b(player.rank)),
    T.field('🎖️', 'Grade', T.m(player.grade)),
    T.field('🎭', 'Class', player.class || 'Fighter'),
    '',
    `❤️ ${T.b('HP')}`,
    T.barLine(player.hp, player.maxHp),
    '',
    `🔋 ${T.b('POWER ENERGY')}`,
    T.barLine(player.powerEnergy, player.maxPowerEnergy),
    '',
    T.field('⚔️', 'Attack', T.m(player.atk)),
    T.field('🛡️', 'Armor', T.m(player.def)),
    T.field('⭐', 'XP', T.m(player.xp)),
    T.field('🪙', 'Coin', T.m(player.coins || 0)),
    T.field('💎', 'Zen', T.m(player.zen || 0))
  ], { kind: 'round', title: T.font('STATUS', 'smallcaps'), width: 24 })

  return [
    T.header({ creators: creatorsOf(settings) }),
    '',
    T.banner('ARISE', { kind: 'block', note: 'the system has recognised you' }),
    '',
    `👤 ${T.hunterName(player.name)}`,
    '',
    T.quote(pick(FIRST_LIGHT, player.userId)),
    '',
    T.rule('AWAKENING COMPLETE', 'thin'),
    '',
    stats,
    '',
    T.rule('', 'hair'),
    '',
    T.field('🎴', 'Cards', 'ready to collect'),
    T.field('🗡️', 'Weapons', 'ready to collect'),
    T.field('⚡', 'Moves', 'from your class'),
    '',
    `${T.i('Train. Explore. Grow.')}`,
    `${T.i('Your story starts here.')} ⚔️`,
    '',
    `Type ${T.b(`${prefix}help`)} to see everything you can do.`,
    `Type ${T.b(`${prefix}stages`)} when you are ready to fight.`
  ].join('\n')
}

/** A returning hunter. Different frame, different copy, same discipline. */
function returnGreeting (player, prefix, settings) {
  const stats = T.frame([
    T.field('🏅', 'Rank', T.b(player.rank)),
    T.field('🎖️', 'Grade', T.m(player.grade)),
    T.field('📈', 'Level', T.m(player.level)),
    '',
    `❤️ ${T.b('HP')}  ${T.barLine(player.hp, player.maxHp)}`,
    `🔋 ${T.b('ENERGY')}  ${T.barLine(player.powerEnergy, player.maxPowerEnergy)}`,
    '',
    T.field('💎', 'Zen', T.m(Number(player.zen || 0).toLocaleString('en-US'))),
    T.field('🏆', 'Record', `${T.m(player.wins)}W / ${T.m(player.losses)}L`)
  ], { kind: 'double', title: T.font('RECORD', 'smallcaps'), width: 24 })

  return [
    T.header({ creators: creatorsOf(settings) }),
    '',
    T.banner('WELCOME BACK', { kind: 'heavy', note: 'your record held' }),
    '',
    `👤 ${T.hunterName(player.name)}`,
    '',
    T.quote(pick(RETURNING, player.userId)),
    '',
    stats,
    '',
    T.rule('', 'dotted'),
    '',
    `${T.b(`${prefix}profile`)}  •  ${T.b(`${prefix}stages`)}  •  ${T.b(`${prefix}help`)}`
  ].join('\n')
}

/** Shown when someone uses a command before registering. */
function notRegistered (prefix, settings) {
  return [
    T.header({ creators: creatorsOf(settings) }),
    '',
    T.frame([
      T.font('THE SYSTEM', 'bold'),
      T.font('DOES NOT KNOW YOU', 'bold'),
      '',
      T.i('yet')
    ], { kind: 'light', width: 22 }),
    '',
    `Register with ${T.b(`${prefix}arise`)} first.`,
    '',
    T.quote('One command. Then everything else opens.')
  ].join('\n')
}

/**
 * Shown when a COMMAND is used in a group that was never registered.
 *
 * The bot used to stay completely silent here, which made a working bot look
 * broken. Ordinary chat is still ignored; only commands get this reply, so the
 * group is never spammed.
 */
function groupNotRegistered (prefix, settings) {
  return [
    T.header({ creators: creatorsOf(settings) }),
    '',
    T.frame([
      '🔒 ' + T.font('GROUP NOT', 'bold'),
      '   ' + T.font('REGISTERED', 'bold')
    ], { kind: 'heavy', width: 22 }),
    '',
    `An admin needs to send ${T.b(`${prefix}register`)} here once.`,
    '',
    T.quote('Then every command works. Nothing else is required.')
  ].join('\n')
}

module.exports = {
  firstGreeting, returnGreeting, notRegistered, groupNotRegistered,
  FIRST_LIGHT, RETURNING, RANK_LINE, pick, creatorsOf
}
