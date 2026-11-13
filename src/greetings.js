'use strict'
/*
 * GREETINGS — the words Architect uses when someone arrives.
 *
 * These are deliberately new. The old build greeted people with
 * "WELCOME TO RYUDEN" / "CHOOSE YOUR PATH" and a six-button menu; none of that
 * copy survives. Everything here is plain text, and the only thing a new
 * hunter is told to do is type a command.
 *
 * A greeting is picked deterministically from the player id, so the same
 * hunter always gets the same line and it never feels like a slot machine.
 */

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

function firstGreeting (player, prefix) {
  return [
    '\u232c AXYN CORE',
    '',
    '\ud83c\udf00 *ARISE*',
    '',
    `> \ud83d\udc64 *${player.name || 'Unnamed Hunter'}*`,
    '',
    pick(FIRST_LIGHT, player.userId),
    '',
    RANK_LINE[player.rank] || `Rank ${player.rank}.`,
    '',
    `\u2764\ufe0f ${player.maxHp} HP  \u2022  \u2694\ufe0f ${player.atk} ATK  \u2022  \ud83d\udee1\ufe0f ${player.def} DEF`,
    `\u26a1 Power Energy *${player.maxPowerEnergy}*`,
    '',
    `Type *${prefix}help* to see what you can do.`,
    `Type *${prefix}stages* when you are ready to fight.`
  ].join('\n')
}

function returnGreeting (player, prefix) {
  return [
    '\u232c AXYN CORE',
    '',
    '\ud83c\udf00 *WELCOME BACK*',
    '',
    `> \ud83d\udc64 *${player.name || 'Unnamed Hunter'}*`,
    '',
    pick(RETURNING, player.userId),
    '',
    `\ud83c\udf96\ufe0f Rank *${player.rank}* \u2022 Grade *${player.grade}* \u2022 Lv. *${player.level}*`,
    `\u2764\ufe0f ${player.hp}/${player.maxHp}  \u2022  \u26a1 ${player.powerEnergy}/${player.maxPowerEnergy}`,
    `\ud83e\ude99 Zen *${Number(player.zen || 0).toLocaleString('en-US')}*`,
    '',
    `*${prefix}profile* \u2022 *${prefix}stages* \u2022 *${prefix}help*`
  ].join('\n')
}

/** Shown when someone uses a command before registering. */
function notRegistered (prefix) {
  return [
    '\u232c AXYN CORE',
    '',
    '\ud83c\udf00 *THE SYSTEM DOES NOT KNOW YOU YET*',
    '',
    `Register with *${prefix}arise* first.`,
    '',
    '> One command. Then everything else opens.'
  ].join('\n')
}

module.exports = { firstGreeting, returnGreeting, notRegistered, FIRST_LIGHT, RETURNING, RANK_LINE, pick }
