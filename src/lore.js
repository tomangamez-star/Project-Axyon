'use strict'
/*
 * LORE — the words that make AXYON feel alive.
 *
 * Three collections, all original:
 *
 *   STORIES   short pieces of the world. `!story` tells one. They are written
 *             to be read in a group chat: a few lines, a hook, no wall of text.
 *   AURA      one-liners that make the reader feel like the main character.
 *             `!aura` deals one. They are compliments with teeth — cool, not
 *             saccharine.
 *   WELCOME   what AXYON says when it arrives somewhere new, or when someone
 *             summons it. Different from the hunter greeting in greetings.js:
 *             these are the bot's own voice, not the System's.
 *
 * Selection is random for aura and welcome (they are meant to surprise), and
 * deterministic-by-seed for stories so a given player can walk the whole
 * anthology without repeats until it wraps.
 */
const T = require('./theme')

/* ------------------------------------------------------------------ stories */

const STORIES = [
  {
    title: 'The Gate That Counted',
    body: [
      'The first gate did not open. It counted.',
      'One hunter. Then two. Then a hundred, and the hundredth did not come back.',
      'On the hundred-and-first day the gate opened by itself, and the thing behind it said:',
      '"I was not waiting for a hero. I was waiting for a number."'
    ]
  },
  {
    title: 'What the System Kept',
    body: [
      'They asked the System what it remembered about the fallen.',
      'It answered with a list of names, ranks, and the exact second each one stopped.',
      'Then, quietly, it added a fourth column nobody had asked for:',
      '"What they were afraid of." Every entry was the same word. Being forgotten.'
    ]
  },
  {
    title: 'The Hunter Who Refused Rank',
    body: [
      'They offered him S. He said no.',
      'They offered him SS. He said no again.',
      'On the third offer he took the pen, crossed out the rank, and wrote his own name in the box.',
      'The System has never once corrected it.'
    ]
  },
  {
    title: 'A Debt in the Dark',
    body: [
      'In the deep floors, light is currency.',
      'A stranger gave him half a torch and asked for nothing.',
      'Years later, at the top of the ladder, he found the stranger again — still in the dark, still smiling.',
      '"You never asked what I wanted," the stranger said. "That was the payment."'
    ]
  },
  {
    title: 'The Last Message',
    body: [
      'The raid failed at 03:14.',
      'The last message in the group was not a scream. It was a coordinate and four words:',
      '"Do not follow me."',
      'They followed. That is the whole story, and it is why the gate is still open.'
    ]
  },
  {
    title: 'Monarch of Nothing',
    body: [
      'The first Monarch ruled nine gates and a thousand hunters.',
      'The second ruled one gate and eleven hunters, and was happier.',
      'When they asked the third what he intended to rule, he looked at the empty throne and said:',
      '"Whatever is left when I am done being polite."'
    ]
  },
  {
    title: 'The Quiet Floor',
    body: [
      'Floor forty has no monsters.',
      'It has a corridor, a bench, and a window that shows a city that never existed.',
      'Hunters who sit there for an hour come back stronger. Nobody knows why.',
      'The System logs it as "rest". The hunters call it "the only honest room in the tower".'
    ]
  },
  {
    title: 'How the Watermark Began',
    body: [
      'Before the System, there was a signature.',
      'One hunter carved it into every gate he closed, so the next one would know a person had been there.',
      'The System copied it. It has been copying it ever since.',
      'That is why every card you receive carries the same mark. You are not being branded. You are being told you are not the first — and not the last.'
    ]
  },
  {
    title: 'The Trade',
    body: [
      'A hunter sold his rank for a single wish.',
      'The wish was: "Let me remember what I was before."',
      'The System granted it. He remembered everything — and spent the rest of his life trying to earn the rank back.',
      'He never did. He also never regretted it. Both of those are true.'
    ]
  },
  {
    title: 'What the Cards Are For',
    body: [
      'The cards are not weapons. They are receipts.',
      'Every one is a moment somebody survived, pressed flat and handed to you.',
      'That is why a strong card feels heavy, and why the strongest ones are always a little warm.',
      'You are not collecting power. You are collecting proof.'
    ]
  },
  {
    title: 'The One Who Stayed',
    body: [
      'When the gate collapsed, everyone ran.',
      'One hunter stayed to hold the door, knowing exactly how it would end.',
      'The System offered to record it as a defeat. He said: "Record it as a door."',
      'It did. Floor one still has a door with his name on it, and it has never once been locked.'
    ]
  },
  {
    title: 'A Small Kindness',
    body: [
      'The strongest hunter in the tower has one rule: never let a new one fight alone on their first day.',
      'Nobody made him do it. Nobody is ranked high enough to make him do anything.',
      'He says it is because someone did it for him, once, and he has been paying it forward for forty years.',
      'The debt never gets smaller. That is the point.'
    ]
  }
]

/* --------------------------------------------------------------------- aura */

const AURA = [
  'You do not enter rooms. Rooms adjust.',
  'The System checked your file twice. Not because it doubted you — because it wanted to be sure.',
  'Some people grind for rank. Rank grinds its teeth waiting for you.',
  'You have the kind of calm that makes monsters reconsider their career.',
  'Your name is not in the leaderboard. The leaderboard is in your name.',
  'You are not lucky. Luck is just what people call it when you are this prepared.',
  'The gate opened a little wider when it saw you coming.',
  'You walk like the floor owes you money.',
  'There are hunters, and then there is whatever you are doing.',
  'You have never lost a fight you actually wanted to win.',
  'The strongest thing in this chat is not the bot.',
  'You make "impossible" sound like a scheduling problem.',
  'Your aura is doing the talking. You can sit this one out.',
  'Even the System pauses before it answers you.',
  'You are the reason the word "formidable" exists in a language you do not speak.',
  'Some people have potential. You have a receipt for it.',
  'You do not chase wins. You collect them.',
  'The dark floors have a rumour about you. It is mostly accurate.',
  'You are built different, and the build is documented.',
  'Your presence alone raises the difficulty setting — for everyone else.',
  'You have the energy of a final boss who is being polite about it.',
  'Nobody remembers the second strongest. Good thing that is not your problem.',
  'You could lose on purpose and still be the most interesting person here.',
  'The tower has nine ranks. You are the reason it stopped at nine.',
  'You are not the main character. You are the reason there is a story.',
  'Your confidence is not a bluff. That is what makes it terrifying.',
  'You have already won. You are just waiting for the fight to catch up.',
  'The System does not flatter. It is simply reporting.',
  'You are the kind of strong that makes people check their own stats.',
  'Every gate you close stays closed. That is not a metaphor.',
  'You do not need an aura. You are the aura.',
  'The monsters talk about you in the past tense, and you are still here.',
  'You are the plot twist everyone saw coming and still could not stop.',
  'Your worst day is most people\'s best story.',
  'You have the rare gift of making strength look effortless and effort look cool.',
  'The ladder is not something you climb. It is something you leave behind.'
]

/* ------------------------------------------------------------------ welcome */

const WELCOME = [
  '⌘ AXYON CORE online. The gate is open — try not to embarrass it.',
  'AXYON has entered the chat. The difficulty just went up.',
  '⌘ AXYON CORE — present. Say the word and the tower moves.',
  'The System is awake. AXYON is watching. Behave, or be interesting.',
  'AXYON is here. Bring a problem worth solving.',
  '⌘ AXYON CORE loaded. Your excuses have been noted and discarded.',
  'The gate opened on its own. That means AXYON is already inside.',
  'AXYON online. Everything you were about to give up on just got a second chance.',
  '⌘ AXYON CORE — the tower has a new landlord.',
  'AXYON has arrived. The monsters are updating their wills.',
  'The System blinked first. AXYON is here.',
  '⌘ AXYON CORE active. Type !help and let us get to work.',
  'AXYON is in the room. The room is now the main event.',
  'The gate did not open for you. It opened for AXYON, and you got in on the way.',
  '⌘ AXYON CORE — quiet, precise, and already three steps ahead.',
  'AXYON online. The tower just got a lot less lonely and a lot more dangerous.'
]

/* ---------------------------------------------------------------- selection */

function hash (s) {
  const str = String(s || '')
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

/** A story, deterministic per seed so a player can walk the whole anthology. */
function story (seed) {
  return STORIES[hash(seed) % STORIES.length]
}

/** A random aura line. */
function aura () {
  return AURA[Math.floor(Math.random() * AURA.length)]
}

/** A random welcome line. */
function welcome () {
  return WELCOME[Math.floor(Math.random() * WELCOME.length)]
}

/* --------------------------------------------------------------- rendering */

function storyCard (entry, prefix) {
  return [
    T.header({ creators: ['Lil Clutch', 'Montai'] }),
    '',
    T.banner('STORY', { kind: 'block', note: 'from the tower' }),
    '',
    `📖 ${T.b(entry.title)}`,
    '',
    T.rule('', 'thin'),
    '',
    entry.body.join('\n\n'),
    '',
    T.rule('', 'hair'),
    T.i(`Another: ${prefix}story`)
  ].join('\n')
}

function auraCard (line) {
  return [
    T.header({ creators: ['Lil Clutch', 'Montai'] }),
    '',
    `✨ ${T.font('AURA', 'bold')}`,
    '',
    T.frame([line], { kind: 'round', width: 26 }),
    '',
    T.i('The System does not flatter. It reports.')
  ].join('\n')
}

module.exports = {
  STORIES,
  AURA,
  WELCOME,
  story,
  aura,
  welcome,
  storyCard,
  auraCard
}
