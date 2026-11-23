'use strict'

// Original, player-persistent floor campaign. Choices change encounters and
// unlock NPC quest threads; the story is deliberately short enough for chat.
const CHAPTERS = [
  {
    title: 'THE CITY THAT FORGOT ITS NAME', place: 'Vesper District', npc: 'Mira Vale',
    intro: [
      'The gate opens onto a rain-soaked city. Every street sign has been scraped clean.',
      'A cracked radio repeats a message: “If the bells ring twice, do not follow the lights.”',
      'A young courier is sheltering beneath a collapsed station awning. Behind her, something moves between the buildings.'
    ],
    prompt: 'Mira notices your arrival and grips a sealed brass case. “You look capable. Are you here to help, or are you just passing through?”',
    choices: [
      { label: 'Protect Mira', result: 'You step between Mira and the movement. She trusts you with the brass case and marks your map.', flags: ['mira_saved'], quest: 'brass_delivery', enemy: { atk: -2 } },
      { label: 'Inspect the radio', result: 'The signal reveals a hidden service tunnel. You learn the creatures are drawn to sound.', flags: ['radio_signal'], quest: null, enemy: { hp: -15 } },
      { label: 'Follow the lights', result: 'The lights lead to a watch post. A scout escapes, but you discover the enemy patrol route.', flags: ['patrol_known'], quest: 'lost_scout', enemy: { atk: -4 } },
      { label: 'Advance quietly', result: 'You avoid the street ambush, but leave the courier and the mystery behind.', flags: ['mira_unhelped'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'brass_delivery', name: 'A CASE FOR THE ARCHIVE', npc: 'Mira Vale', description: 'Carry Mira’s sealed case through the next gate.', objective: 'Choose “Protect Mira” on the Vesper District floor.', reward: { xp: 90, zen: 120 } },
      { id: 'lost_scout', name: 'THE MISSING SCOUT', npc: 'Mira Vale', description: 'Find the scout who knows the patrol route.', objective: 'Choose “Follow the lights” on the Vesper District floor.', reward: { xp: 110, zen: 100 } }
    ]
  },
  {
    title: 'THE ARCHIVE BELOW', place: 'Cinder Archive', npc: 'Keeper Orin',
    intro: [
      'The stairwell descends beneath the city. Shelves stretch into darkness, packed with records that rewrite themselves.',
      'An old keeper blocks the next door. His lantern burns with a cold blue flame.',
      '“The Archive remembers every hunter who entered,” he says. “It has started remembering people who never existed.”'
    ],
    prompt: 'Keeper Orin offers a choice: recover the missing ledger, or help him seal the door before the Archive wakes.',
    choices: [
      { label: 'Recover the ledger', result: 'You retrieve a ledger bearing your name, dated years before your birth. Orin records the discovery.', flags: ['ledger_found'], quest: 'ledger_truth', enemy: { hp: -20 } },
      { label: 'Help seal the door', result: 'The seal holds. Orin gives you a ward that weakens the next enemy.', flags: ['archive_sealed'], quest: 'keepers_ward', enemy: { atk: -5 } },
      { label: 'Question Orin', result: 'Orin admits he has seen your name in the Archive before. He refuses to explain further.', flags: ['orin_questioned'], quest: 'keepers_secret', enemy: {} },
      { label: 'Take the forbidden key', result: 'You take the key. The Archive notices — and something on the other side answers.', flags: ['forbidden_key'], quest: null, enemy: { hp: 25, atk: 3 } }
    ],
    quests: [
      { id: 'ledger_truth', name: 'A NAME BEFORE BIRTH', npc: 'Keeper Orin', description: 'Recover the ledger that contains your impossible record.', objective: 'Choose “Recover the ledger” in the Cinder Archive.', reward: { xp: 150, zen: 180 } },
      { id: 'keepers_ward', name: 'THE KEEPER’S WARD', npc: 'Keeper Orin', description: 'Help Orin secure the Archive door.', objective: 'Choose “Help seal the door” in the Cinder Archive.', reward: { xp: 120, zen: 220 } },
      { id: 'keepers_secret', name: 'WHAT ORIN KNOWS', npc: 'Keeper Orin', description: 'Get Orin to reveal what he knows about your name.', objective: 'Choose “Question Orin” in the Cinder Archive.', reward: { xp: 180, zen: 140 } }
    ]
  },
  {
    title: 'THE BELL WITHOUT A TOWER', place: 'Ashen Quarter', npc: 'Sable, the Bellwright',
    intro: [
      'A bell rings overhead, though the skyline is empty.',
      'Every ring freezes the rain in mid-air. On the third, the shadows turn toward you.',
      'A masked craftswoman steps from a doorway carrying a hammer made from gate-metal.'
    ],
    prompt: 'Sable says the bell is holding the district together. “Break it, silence it, or find who is ringing it.”',
    choices: [
      { label: 'Find the bell-ringer', result: 'You trace the sound to a hidden rooftop. The bell-ringer leaves behind a symbol linked to the gates.', flags: ['bell_ringer_trail'], quest: 'silent_signal', enemy: { hp: -10 } },
      { label: 'Help Sable repair it', result: 'Sable repairs the cracked bell. Its next ring shields you from the first enemy strike.', flags: ['sable_allied'], quest: 'bellwright', enemy: { atk: -6 } },
      { label: 'Silence the bell', result: 'The ringing stops. The district goes quiet — too quiet. Something begins moving below.', flags: ['bell_silenced'], quest: null, enemy: { hp: 10 } },
      { label: 'Strike the bell', result: 'Your strike sends a pulse through the gate. The response comes from far below.', flags: ['bell_struck'], quest: 'deep_answer', enemy: { hp: 30, atk: 2 } }
    ],
    quests: [
      { id: 'silent_signal', name: 'THE SILENT SIGNAL', npc: 'Sable', description: 'Track the hidden bell-ringer.', objective: 'Choose “Find the bell-ringer” in the Ashen Quarter.', reward: { xp: 190, zen: 190 } },
      { id: 'bellwright', name: 'THE BELLWRIGHT’S PROMISE', npc: 'Sable', description: 'Help Sable restore the bell.', objective: 'Choose “Help Sable repair it” in the Ashen Quarter.', reward: { xp: 160, zen: 260 } },
      { id: 'deep_answer', name: 'AN ANSWER BELOW', npc: 'Sable', description: 'Discover what answered the bell.', objective: 'Choose “Strike the bell” in the Ashen Quarter.', reward: { xp: 240, zen: 150 } }
    ]
  },
  {
    title: 'THE HUNTER WHO VANISHED', place: 'Glasswood Crossing', npc: 'Ren, the Gate Cartographer',
    intro: [
      'The road leaves the city and enters a forest of glass trees. Their branches replay fragments of conversations that have not happened yet.',
      'A map is pinned to a tree with a hunter’s badge. The name has been scratched away.',
      'Ren steps out from the mist. “That badge belongs to my partner. I watched him vanish here yesterday. Or perhaps tomorrow.”'
    ],
    prompt: 'Ren asks you to help locate the missing hunter before the forest rearranges itself again.',
    choices: [
      { label: 'Search the echo trail', result: 'You follow the repeated footsteps and find the missing hunter’s signal beneath the roots.', flags: ['echo_trail'], quest: 'glasswood_echo', enemy: { hp: -15 } },
      { label: 'Study the badge', result: 'The badge contains a gate coordinate that should not exist. Ren copies it into his map.', flags: ['impossible_coordinate'], quest: 'lost_coordinate', enemy: {} },
      { label: 'Guard Ren', result: 'A glass beast emerges. You hold it off while Ren escapes with the map.', flags: ['ren_protected'], quest: 'cartographers_debt', enemy: { atk: -5 } },
      { label: 'Enter the mirrored grove', result: 'Your reflection moves a second too late. Something on the other side learns your face.', flags: ['mirror_grove'], quest: null, enemy: { hp: 20, atk: 2 } }
    ],
    quests: [
      { id: 'glasswood_echo', name: 'THE ECHO TRAIL', npc: 'Ren', description: 'Track the missing hunter through the glasswood.', objective: 'Choose “Search the echo trail” in Glasswood Crossing.', reward: { xp: 220, zen: 210 } },
      { id: 'lost_coordinate', name: 'A PLACE THAT ISN’T THERE', npc: 'Ren', description: 'Decode the impossible gate coordinate.', objective: 'Choose “Study the badge” in Glasswood Crossing.', reward: { xp: 180, zen: 260 } },
      { id: 'cartographers_debt', name: 'THE CARTOGRAPHER’S DEBT', npc: 'Ren', description: 'Keep Ren alive long enough to finish his map.', objective: 'Choose “Guard Ren” in Glasswood Crossing.', reward: { xp: 200, zen: 240 } }
    ]
  },
  {
    title: 'THE LAST SAFEHOUSE', place: 'Northline Refuge', npc: 'Captain Ilyra',
    intro: [
      'Beyond the forest, a fortress burns without consuming its walls. Hunters crowd behind its gates, waiting for an evacuation that never comes.',
      'Captain Ilyra has barricaded the command room. The gate outside is changing shape with every heartbeat.',
      'A child hands you a list of names. The final name is yours.'
    ],
    prompt: 'Ilyra needs one decision before the refuge falls: save the people, secure the records, or confront what is changing the gate.',
    choices: [
      { label: 'Evacuate the refuge', result: 'You lead the survivors through a maintenance route. Ilyra promises the refuge will remember your name.', flags: ['refuge_saved'], quest: 'northline_survivors', enemy: { atk: -5 } },
      { label: 'Secure the records', result: 'You recover the refuge logs. They reveal that the gates are being opened from inside the System.', flags: ['refuge_records'], quest: 'system_below', enemy: { hp: -20 } },
      { label: 'Confront the gate', result: 'You step into the shifting doorway. A voice on the other side calls you by a name you have never used.', flags: ['gate_voice'], quest: 'voice_beyond', enemy: { hp: 25, atk: 3 } },
      { label: 'Trust Ilyra’s plan', result: 'Ilyra reveals a hidden route and joins your contact network. The refuge falls, but its people escape.', flags: ['ilyra_allied'], quest: 'captains_network', enemy: {} }
    ],
    quests: [
      { id: 'northline_survivors', name: 'NORTHLINE SURVIVORS', npc: 'Captain Ilyra', description: 'Get the refuge civilians to safety.', objective: 'Choose “Evacuate the refuge” in Northline Refuge.', reward: { xp: 260, zen: 280 } },
      { id: 'system_below', name: 'THE SYSTEM BELOW', npc: 'Captain Ilyra', description: 'Recover the records hidden in the command room.', objective: 'Choose “Secure the records” in Northline Refuge.', reward: { xp: 300, zen: 240 } },
      { id: 'voice_beyond', name: 'THE VOICE BEYOND', npc: 'Unknown', description: 'Discover who is speaking through the gate.', objective: 'Choose “Confront the gate” in Northline Refuge.', reward: { xp: 320, zen: 220 } },
      { id: 'captains_network', name: 'A CAPTAIN’S NETWORK', npc: 'Captain Ilyra', description: 'Build an alliance with Ilyra and the surviving hunters.', objective: 'Choose “Trust Ilyra’s plan” in Northline Refuge.', reward: { xp: 230, zen: 320 } }
    ]
  }
]

function chapterFor (ordinal) { return CHAPTERS[(Math.max(1, Number(ordinal) || 1) - 1) % CHAPTERS.length] }
function cleanState (state = {}) {
  return { chapter: Number(state.chapter) || 1, flags: Array.isArray(state.flags) ? state.flags : [], quests: state.quests && typeof state.quests === 'object' ? state.quests : {}, history: Array.isArray(state.history) ? state.history.slice(-20) : [] }
}
function begin (ordinal, state) {
  const chapter = chapterFor(ordinal)
  const saved = cleanState(state)
  return { chapter, state: saved, text: [
    '⌬ AXYN CORE', `📖 CHAPTER ${Math.max(1, Number(ordinal) || 1)} — ${chapter.title}`,
    `⌖ ${chapter.place.toUpperCase()}`, '', ...chapter.intro, '', `👤 ${chapter.npc}`, chapter.prompt,
    '', '╭─〔 YOUR DECISION 〕', ...chapter.choices.map((c, i) => `${i + 1}. ${c.label}`), '╰──────────────',
    'Reply with *!choice 1-4* to decide. Your choice changes the encounter and may unlock an NPC side quest.'
  ].join('\n') }
}
function choose (ordinal, choiceNumber, state) {
  const chapter = chapterFor(ordinal)
  const saved = cleanState(state)
  const choice = chapter.choices[Number(choiceNumber) - 1]
  if (!choice) return { ok: false, message: 'Choose a story option from 1 to 4.' }
  saved.flags = [...new Set([...saved.flags, ...choice.flags])]
  saved.history.push({ floor: Number(ordinal), chapter: chapter.title, choice: choice.label, at: new Date().toISOString() })
  if (choice.quest) {
    const q = chapter.quests.find(x => x.id === choice.quest)
    if (q && !saved.quests[q.id]) saved.quests[q.id] = { ...q, status: 'active' }
  }
  saved.chapter = Math.max(saved.chapter, Number(ordinal) + 1)
  return { ok: true, chapter, choice, state: saved, message: [
    `⌬ ${chapter.title}`, '', `*${choice.label.toUpperCase()}*`, choice.result,
    choice.quest ? `\n📜 NPC SIDE QUEST UNLOCKED: *${chapter.quests.find(q => q.id === choice.quest)?.name}*\nUse *!quest* to view it.` : '',
    '', 'The path forward opens. The encounter begins.'
  ].filter(Boolean).join('\n') }
}
function questList (state) {
  const saved = cleanState(state)
  const rows = Object.values(saved.quests)
  if (!rows.length) return 'No side quests discovered yet. Speak to NPCs during floor chapters to uncover them.'
  return ['⌬ AXYN CORE', '📜 *NPC SIDE QUESTS*', '', ...rows.map(q => `${q.status === 'complete' ? '✅' : q.status === 'claimed' ? '🏅' : '▫️'} *${q.name}*  3${q.id}
   NPC: ${q.npc}
   ${q.description}
   Objective: ${q.objective}
   Reward: ${q.reward.xp} XP • ${q.reward.zen} Zen`), '', 'Use *!quest claim <id>* after completing an objective.'].join('\n')
}
function claim (state, id) {
  const saved = cleanState(state)
  const q = saved.quests[String(id || '').toLowerCase()]
  if (!q) return { ok: false, message: 'That quest is not in your journal.' }
  if (q.status === 'claimed') return { ok: false, message: 'That quest reward has already been claimed.' }
  if (q.status !== 'complete') return { ok: false, message: 'That quest objective is not complete yet.' }
  q.status = 'claimed'
  return { ok: true, state: saved, reward: q.reward, name: q.name }
}
function completeQuest (state, questId) {
  const saved = cleanState(state)
  const q = saved.quests[questId]
  if (q && q.status === 'active') q.status = 'complete'
  return saved
}
module.exports = { CHAPTERS, chapterFor, cleanState, begin, choose, questList, claim, completeQuest }
