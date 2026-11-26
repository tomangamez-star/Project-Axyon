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
  ,
  {
    title: 'THE SHATTERED MERIDIAN', place: 'Meridian Scar', npc: 'Tessa Vorn',
    intro: [
      'The road beyond Northline splits around a vast fracture in the ground. Blue light rises from its depths, carrying voices from distant gates.',
      'Survey markers have been driven into the stone, but every marker points in a different direction.',
      'Tessa Vorn, a gate engineer, is trying to keep a bridge stable while something climbs toward the surface.'
    ],
    prompt: 'Tessa needs you to choose: reinforce the bridge, descend into the fracture, or draw the creature away.',
    choices: [
      { label: 'Reinforce the bridge', result: 'You secure the supports. The crossing steadies, and Tessa shares a safe route through the scar.', flags: ['meridian_bridge'], quest: 'hold_the_line', enemy: { atk: -6 } },
      { label: 'Descend into the fracture', result: 'Below the surface you find a gate fragment pulsing in time with your System. The creature senses you.', flags: ['meridian_fragment'], quest: 'below_the_meridian', enemy: { hp: 25, atk: 3 } },
      { label: 'Lure the creature away', result: 'You draw the threat from the bridge and give Tessa time to evacuate her crew.', flags: ['meridian_lure'], quest: 'engineers_escape', enemy: { hp: -15 } },
      { label: 'Study the markers', result: 'The markers form a map of a route that has not opened yet. Tessa copies it before the light fades.', flags: ['meridian_map'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'hold_the_line', name: 'HOLD THE LINE', npc: 'Tessa Vorn', description: 'Keep the Meridian crossing stable.', objective: 'Choose “Reinforce the bridge” at Meridian Scar.', reward: { xp: 360, zen: 420 } },
      { id: 'below_the_meridian', name: 'BENEATH THE SCAR', npc: 'Tessa Vorn', description: 'Recover the gate fragment below the fracture.', objective: 'Choose “Descend into the fracture” at Meridian Scar.', reward: { xp: 420, zen: 380 } },
      { id: 'engineers_escape', name: 'THE ENGINEERS’ ESCAPE', npc: 'Tessa Vorn', description: 'Draw the creature away from Tessa’s crew.', objective: 'Choose “Lure the creature away” at Meridian Scar.', reward: { xp: 390, zen: 450 } }
    ]
  },
  {
    title: 'THE CATHEDRAL OF ECHOES', place: 'Vesper Basilica', npc: 'Brother Cael',
    intro: [
      'A cathedral stands in the centre of an abandoned district. Its bells ring from empty towers, and every echo repeats a command in the System’s voice.',
      'Brother Cael has sealed the doors from within. He claims the echoes are memories stolen from hunters who never returned.',
      'A choir of shadows gathers behind the altar.'
    ],
    prompt: 'Cael asks you to silence the bells, follow the voices, or protect the people hiding below.',
    choices: [
      { label: 'Silence the bells', result: 'The echoes stop. For one quiet moment, the System cannot hear you.', flags: ['cathedral_silent'], quest: 'quiet_the_choir', enemy: { atk: -7 } },
      { label: 'Follow the voices', result: 'The voices lead to a hidden chamber containing a record of the first gate breach.', flags: ['first_breach_record'], quest: 'first_breach', enemy: { hp: -20 } },
      { label: 'Defend the lower hall', result: 'You hold the stairwell while Cael leads the survivors to safety.', flags: ['lower_hall_saved'], quest: 'last_congregation', enemy: { atk: -5 } },
      { label: 'Break the altar seal', result: 'The altar cracks. Something answers from beneath the cathedral and the shadows grow stronger.', flags: ['altar_broken'], quest: null, enemy: { hp: 35, atk: 4 } }
    ],
    quests: [
      { id: 'quiet_the_choir', name: 'QUIET THE CHOIR', npc: 'Brother Cael', description: 'Stop the cathedral echoes.', objective: 'Choose “Silence the bells” at Vesper Basilica.', reward: { xp: 450, zen: 520 } },
      { id: 'first_breach', name: 'THE FIRST BREACH', npc: 'Brother Cael', description: 'Find the record of the first gate breach.', objective: 'Choose “Follow the voices” at Vesper Basilica.', reward: { xp: 520, zen: 480 } },
      { id: 'last_congregation', name: 'THE LAST CONGREGATION', npc: 'Brother Cael', description: 'Protect the survivors in the lower hall.', objective: 'Choose “Defend the lower hall” at Vesper Basilica.', reward: { xp: 480, zen: 560 } }
    ]
  },
  {
    title: 'THE NAMELESS CITADEL', place: 'Nhal Keep', npc: 'Veyra Nox',
    intro: [
      'The citadel has no entrance, only a wall of black stone covered in names. Some belong to missing hunters. One is yours, written in fresh silver.',
      'Veyra Nox, a former keeper, waits beside a gate that opens only when a name is spoken.',
      'Inside, the corridors rearrange themselves around whoever enters.'
    ],
    prompt: 'Veyra offers three paths: speak your name, erase the inscription, or let her open the gate.',
    choices: [
      { label: 'Speak your name', result: 'The gate recognises you. A hidden passage opens, though something now knows exactly where you are.', flags: ['citadel_named'], quest: 'the_name_test', enemy: { hp: 20, atk: 2 } },
      { label: 'Erase the inscription', result: 'Your name vanishes from the wall. The citadel loses its hold over the passage.', flags: ['name_erased'], quest: 'unwritten', enemy: { atk: -8 } },
      { label: 'Trust Veyra', result: 'Veyra uses an old keeper’s seal to open a side entrance and gives you the remaining key.', flags: ['veyra_trusted'], quest: 'keepers_key', enemy: { hp: -20 } },
      { label: 'Enter without answering', result: 'You force the gate. The corridors shift violently, but you reach the inner court.', flags: ['citadel_forced'], quest: null, enemy: { hp: 40, atk: 4 } }
    ],
    quests: [
      { id: 'the_name_test', name: 'THE NAME TEST', npc: 'Veyra Nox', description: 'Learn why the citadel already knows your name.', objective: 'Choose “Speak your name” at Nhal Keep.', reward: { xp: 600, zen: 650 } },
      { id: 'unwritten', name: 'THE UNWRITTEN', npc: 'Veyra Nox', description: 'Remove your name from the citadel wall.', objective: 'Choose “Erase the inscription” at Nhal Keep.', reward: { xp: 620, zen: 620 } },
      { id: 'keepers_key', name: 'THE KEEPER’S KEY', npc: 'Veyra Nox', description: 'Earn Veyra’s trust and take the old seal.', objective: 'Choose “Trust Veyra” at Nhal Keep.', reward: { xp: 580, zen: 700 } }
    ]
  },
  {
    title: 'THRONE OF THE HOLLOW KING', place: 'Crownfall Expanse', npc: 'Marshal Edrin',
    intro: [
      'A dead kingdom stretches beneath a sky split by a permanent red aurora. At its centre stands a throne surrounded by empty armour.',
      'Marshal Edrin commands the last group of gate wardens. Their reports describe a king who rules without a body.',
      'The throne room doors open before you reach them.'
    ],
    prompt: 'Edrin asks you to rally the wardens, investigate the throne, or challenge the king’s unseen guard.',
    choices: [
      { label: 'Rally the wardens', result: 'The wardens form a line behind you. Their signal weakens the king’s influence over the arena.', flags: ['wardens_rallied'], quest: 'crownfall_line', enemy: { atk: -9 } },
      { label: 'Investigate the throne', result: 'You find a crown-shaped imprint and a message: the king is a title passed between vessels.', flags: ['hollow_crown'], quest: 'vessel_of_kings', enemy: { hp: -15 } },
      { label: 'Challenge the guard', result: 'The empty armour moves as one. You break through, but the throne begins to awaken.', flags: ['guard_challenged'], quest: 'empty_army', enemy: { hp: 45, atk: 5 } },
      { label: 'Search the royal archive', result: 'The archive reveals a sealed route leading beyond the kingdom.', flags: ['royal_route'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'crownfall_line', name: 'THE CROWNFALL LINE', npc: 'Marshal Edrin', description: 'Rally the last wardens against the hollow king.', objective: 'Choose “Rally the wardens” at Crownfall Expanse.', reward: { xp: 700, zen: 800 } },
      { id: 'vessel_of_kings', name: 'VESSEL OF KINGS', npc: 'Marshal Edrin', description: 'Discover how the hollow king survives.', objective: 'Choose “Investigate the throne” at Crownfall Expanse.', reward: { xp: 760, zen: 740 } },
      { id: 'empty_army', name: 'THE EMPTY ARMY', npc: 'Marshal Edrin', description: 'Break the throne guard.', objective: 'Choose “Challenge the guard” at Crownfall Expanse.', reward: { xp: 820, zen: 700 } }
    ]
  },
  {
    title: 'THE GATE SOVEREIGN', place: 'The Origin Gate', npc: 'The First Witness',
    intro: [
      'Beyond the kingdom lies a gate larger than the horizon. Its surface carries every mark left by every hunter who has ever entered a dungeon.',
      'The First Witness stands before it, wearing no rank and carrying no weapon. The System cannot identify them.',
      'Behind the gate, a second world waits in complete silence.'
    ],
    prompt: 'The Witness gives you one final choice: open the gate, seal it, or demand the truth from the System.',
    choices: [
      { label: 'Open the gate', result: 'The gate unfolds into a path. The world beyond recognises your arrival, and the next chapter begins elsewhere.', flags: ['origin_opened'], quest: 'beyond_the_gate', enemy: { hp: 30, atk: 4 } },
      { label: 'Seal the gate', result: 'You lock the passage from this side. The pressure fades, but the Witness warns that another gate will appear.', flags: ['origin_sealed'], quest: 'last_seal', enemy: { atk: -10 } },
      { label: 'Question the System', result: 'For the first time, the System pauses before answering. A hidden record is added to your journal.', flags: ['system_questioned'], quest: 'system_answer', enemy: { hp: -25 } },
      { label: 'Challenge the Witness', result: 'The Witness accepts. The gate lights up, and the final guardian steps forward.', flags: ['witness_challenged'], quest: null, enemy: { hp: 55, atk: 6 } }
    ],
    quests: [
      { id: 'beyond_the_gate', name: 'BEYOND THE GATE', npc: 'The First Witness', description: 'Open the Origin Gate and learn what waits beyond.', objective: 'Choose “Open the gate” at the Origin Gate.', reward: { xp: 950, zen: 1100 } },
      { id: 'last_seal', name: 'THE LAST SEAL', npc: 'The First Witness', description: 'Seal the Origin Gate.', objective: 'Choose “Seal the gate” at the Origin Gate.', reward: { xp: 900, zen: 1200 } },
      { id: 'system_answer', name: 'THE SYSTEM’S ANSWER', npc: 'The First Witness', description: 'Force the System to reveal a hidden record.', objective: 'Choose “Question the System” at the Origin Gate.', reward: { xp: 1050, zen: 1000 } }
    ]
  }

]

function chapterFor (ordinal) { return CHAPTERS[(Math.max(1, Number(ordinal) || 1) - 1) % CHAPTERS.length] }
function cleanState (state = {}) {
  return { chapter: Number(state.chapter) || 1, flags: Array.isArray(state.flags) ? state.flags : [], quests: state.quests && typeof state.quests === 'object' ? state.quests : {}, history: Array.isArray(state.history) ? state.history.slice(-20) : [], discoveries: Array.isArray(state.discoveries) ? state.discoveries.slice(-80) : [], investigations: Array.isArray(state.investigations) ? state.investigations.slice(-80) : [], npcContacts: Array.isArray(state.npcContacts) ? state.npcContacts.slice(-50) : [] }
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
function explore (ordinal, state) {
  const chapter = chapterFor(ordinal)
  const saved = cleanState(state)
  const key = `floor_${Math.max(1, Number(ordinal) || 1)}_zone`
  const found = saved.discoveries.includes(key)
  if (!found) saved.discoveries.push(key)
  const details = [
    'Rainwater runs uphill toward the gate.',
    'Dust falls from the ceiling in patterns that resemble written names.',
    'The air vibrates whenever the unseen bell rings.',
    'The glass branches repeat a footprint that has not been made yet.',
    'The refuge walls contain a second set of evacuation marks.',
    'The Meridian stones carry a map that changes when you look away.',
    'The cathedral floor vibrates with echoes from a forgotten battle.',
    'The citadel wall has a blank space shaped exactly like your shadow.',
    'The royal archive records a king who was erased from every portrait.',
    'The Origin Gate bears a mark matching the System interface.'
  ]
  return { ok: true, state: saved, repeated: found, chapter,
    message: found
      ? `You retrace the area around *${chapter.place}*. Nothing new has changed, but the route is familiar now.`
      : `⌖ *${chapter.place.toUpperCase()} — AREA DISCOVERED*\n\n${details[(Math.max(1, Number(ordinal) || 1) - 1) % details.length]}\n\nThe discovery has been added to your journal.` }
}
function investigate (ordinal, target, state) {
  const chapter = chapterFor(ordinal)
  const saved = cleanState(state)
  const subject = String(target || '').trim().slice(0, 60) || chapter.place
  const key = `floor_${Math.max(1, Number(ordinal) || 1)}:${subject.toLowerCase()}`
  const found = saved.investigations.includes(key)
  if (!found) saved.investigations.push(key)
  const hints = [
    'The radio signal repeats a warning about the lights and points toward a service tunnel.',
    'The ledger ink is newer than the paper. Someone has been editing the Archive in real time.',
    'The bell-metal carries a second vibration beneath the audible ring.',
    'The badge coordinates shift when viewed through the glass branches.',
    'The evacuation list includes names that are not present in the refuge.'
  ]
  return { ok: true, state: saved, repeated: found,
    message: found ? `You have already examined *${subject}*. No new clue appears.`
      : `🔎 *INVESTIGATION — ${subject.toUpperCase()}*\n\n${hints[(Math.max(1, Number(ordinal) || 1) - 1) % hints.length]}` }
}
function talk (ordinal, target, state) {
  const chapter = chapterFor(ordinal)
  const saved = cleanState(state)
  const who = String(target || '').trim().toLowerCase()
  const npc = chapter.npc
  if (who && !npc.toLowerCase().includes(who) && !who.includes(npc.toLowerCase().split(',')[0])) {
    return { ok: false, message: `No one named *${target}* is available here. The current contact is *${npc}*.` }
  }
  const id = `floor_${Math.max(1, Number(ordinal) || 1)}:${npc.toLowerCase()}`
  const first = !saved.npcContacts.includes(id)
  if (first) saved.npcContacts.push(id)
  const dialogue = [
    '“Keep the case sealed. Whatever is calling from inside the gate already knows what is in it.”',
    '“The Archive does not predict the future. It files memories before they happen.”',
    '“If the bell rings a fourth time, do not answer it.”',
    '“The forest is not changing its paths. It is changing which version of you walks them.”',
    '“The refuge can be rebuilt. The records cannot.”'
  ]
  return { ok: true, state: saved, first, npc,
    message: first ? `👤 *${npc.toUpperCase()}*\n\n${dialogue[(Math.max(1, Number(ordinal) || 1) - 1) % dialogue.length]}`
      : `${npc} has nothing new to add right now. Your earlier conversation is recorded.` }
}
function abandonQuest (state, id) {
  const saved = cleanState(state)
  const q = saved.quests[String(id || '').toLowerCase()]
  if (!q) return { ok: false, message: 'That quest is not in your journal.' }
  if (q.status === 'claimed') return { ok: false, message: 'A completed and claimed quest cannot be abandoned.' }
  if (q.status === 'complete') return { ok: false, message: 'That quest is complete. Claim its reward instead.' }
  q.status = 'abandoned'
  return { ok: true, state: saved, name: q.name }
}
function objectives (state) {
  const saved = cleanState(state)
  const quests = Object.values(saved.quests)
  return quests.map(q => ({ id: q.id, name: q.name, status: q.status, objective: q.objective }))
}
module.exports = { CHAPTERS, chapterFor, cleanState, begin, choose, questList, claim, completeQuest, explore, investigate, talk, abandonQuest, objectives }
