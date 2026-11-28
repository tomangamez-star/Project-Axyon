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
  },
  {
    title: 'THE EMBERGLASS FOUNDRY', place: 'Cinderwake Foundry', npc: 'Foreman Kael Voss',
    intro: [
      'The passage opens above a foundry suspended over a river of molten glass. Machinery keeps moving although every furnace has been extinguished.',
      'Foreman Kael Voss points to a cracked control core. Something below the furnace floor is sending commands through the old machines.',
      'A line of forged guardians turns toward the gate as the foundry wakes.'
    ],
    prompt: 'Kael asks you to stabilise the core, trace the signal, or stop the machines before the whole foundry collapses.',
    choices: [
      { label: 'Stabilise the control core', result: 'You reset the core and the foundry settles. Kael marks a safe route through the lower works.', flags: ['foundry_core_stable'], quest: 'foundry_anchor', enemy: { atk: -6 } },
      { label: 'Trace the hidden signal', result: 'The signal leads to an old gate relay bearing the same mark as the Origin Gate.', flags: ['foundry_signal_traced'], quest: 'silent_relay', enemy: { hp: -20 } },
      { label: 'Free the forged guardians', result: 'You break the command seal. The guardians stop fighting, but the foundry releases its warden.', flags: ['guardians_freed'], quest: 'forged_release', enemy: { hp: 35, atk: 3 } },
      { label: 'Shut down the furnaces', result: 'The machines fall silent. A sealed lift opens beneath the central furnace.', flags: ['foundry_silenced'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'foundry_anchor', name: 'THE FOUNDRY ANCHOR', npc: 'Kael Voss', description: 'Secure the foundry control core.', objective: 'Choose “Stabilise the control core” at Cinderwake Foundry.', reward: { xp: 1050, zen: 1250 } },
      { id: 'silent_relay', name: 'THE SILENT RELAY', npc: 'Kael Voss', description: 'Trace the signal beneath the foundry.', objective: 'Choose “Trace the hidden signal” at Cinderwake Foundry.', reward: { xp: 1150, zen: 1200 } },
      { id: 'forged_release', name: 'THE FORGED RELEASE', npc: 'Kael Voss', description: 'Free the guardians from the command seal.', objective: 'Choose “Free the forged guardians” at Cinderwake Foundry.', reward: { xp: 1200, zen: 1150 } }
    ]
  },
  {
    title: 'THE VEILWATER TRENCH', place: 'Veilwater Deep', npc: 'Diver Sera Nym',
    intro: [
      'A flooded gate opens into a trench where the water hangs in suspended sheets. Lanterns drift through it, each carrying a memory from a missing hunter.',
      'Diver Sera Nym has found a pressure door but cannot open it while the trench current keeps changing direction.',
      'A shape moves beneath the glassy surface.'
    ],
    prompt: 'Sera needs you to redirect the current, recover the lantern records, or force the pressure door.',
    choices: [
      { label: 'Redirect the current', result: 'The water settles into a single stream and the pressure door unlocks.', flags: ['trench_current'], quest: 'safe_depths', enemy: { atk: -7 } },
      { label: 'Recover the lantern records', result: 'The records reveal a route used by hunters who entered the trench long before the first ten floors were mapped.', flags: ['lantern_records'], quest: 'lost_divers', enemy: { hp: -25 } },
      { label: 'Force the pressure door', result: 'The door gives way, sending a shock through the trench and waking its guardian.', flags: ['pressure_door_forced'], quest: 'deep_pressure', enemy: { hp: 40, atk: 4 } },
      { label: 'Follow the shadow below', result: 'You follow the movement to a forgotten airlock. Something has been using it from the other side.', flags: ['trench_shadow'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'safe_depths', name: 'SAFE DEPTHS', npc: 'Sera Nym', description: 'Make a stable route through Veilwater.', objective: 'Choose “Redirect the current” at Veilwater Deep.', reward: { xp: 1250, zen: 1400 } },
      { id: 'lost_divers', name: 'THE LOST DIVERS', npc: 'Sera Nym', description: 'Recover the old lantern records.', objective: 'Choose “Recover the lantern records” at Veilwater Deep.', reward: { xp: 1300, zen: 1350 } },
      { id: 'deep_pressure', name: 'DEEP PRESSURE', npc: 'Sera Nym', description: 'Open the pressure door and face what answers.', objective: 'Choose “Force the pressure door” at Veilwater Deep.', reward: { xp: 1400, zen: 1300 } }
    ]
  },
  {
    title: 'THE OSSUARY OF NAMES', place: 'Pale Reliquary', npc: 'Archivist Neral',
    intro: [
      'The trench gives way to a chamber built from pale stone and sealed nameplates. Every wall records a hunter who entered the gate system and never returned.',
      'Archivist Neral is searching for a name that has been removed from every record, including his own notes.',
      'The empty nameplate begins to glow.'
    ],
    prompt: 'Neral asks you to restore the missing name, examine the sealed shelves, or destroy the plate.',
    choices: [
      { label: 'Restore the missing name', result: 'The name returns to the wall. A hidden record identifies the keeper of the reliquary.', flags: ['name_restored'], quest: 'name_returned', enemy: { hp: -25 } },
      { label: 'Examine the sealed shelves', result: 'You uncover records proving that the reliquary was built to contain a living memory.', flags: ['sealed_shelves'], quest: 'living_record', enemy: {} },
      { label: 'Destroy the nameplate', result: 'The plate breaks and the room answers with a wave of cold light.', flags: ['plate_destroyed'], quest: 'broken_record', enemy: { hp: 45, atk: 4 } },
      { label: 'Ask Neral to read it aloud', result: 'Neral speaks the erased name. A distant gate unlocks, then something answers in his voice.', flags: ['name_spoken'], quest: null, enemy: { atk: -5 } }
    ],
    quests: [
      { id: 'name_returned', name: 'A NAME RETURNED', npc: 'Archivist Neral', description: 'Restore the missing name in the reliquary.', objective: 'Choose “Restore the missing name” at Pale Reliquary.', reward: { xp: 1450, zen: 1500 } },
      { id: 'living_record', name: 'THE LIVING RECORD', npc: 'Archivist Neral', description: 'Discover what the sealed shelves contain.', objective: 'Choose “Examine the sealed shelves” at Pale Reliquary.', reward: { xp: 1500, zen: 1450 } },
      { id: 'broken_record', name: 'THE BROKEN RECORD', npc: 'Archivist Neral', description: 'Break the plate and survive its response.', objective: 'Choose “Destroy the nameplate” at Pale Reliquary.', reward: { xp: 1600, zen: 1400 } }
    ]
  },
  {
    title: 'THE STORMBOUND SPIRE', place: 'Tempest Crown', npc: 'Warden Ivara',
    intro: [
      'A narrow tower rises through a permanent storm. Lightning travels down its outer walls without ever striking the ground.',
      'Warden Ivara guards a lift that leads to the upper levels. The storm is being held in place by four failing conductors.',
      'The tower rings like a bell as the next surge gathers.'
    ],
    prompt: 'Ivara asks you to repair the conductors, climb through the storm, or draw the surge away from the lift.',
    choices: [
      { label: 'Repair the conductors', result: 'The storm loses strength and the lift becomes safe to use.', flags: ['spire_conductors'], quest: 'steady_the_spire', enemy: { atk: -8 } },
      { label: 'Climb through the storm', result: 'You reach the upper platform and find a map etched into the lightning rods.', flags: ['storm_climb'], quest: 'lightning_map', enemy: { hp: -20 } },
      { label: 'Draw the surge away', result: 'The current follows you across the platform, exposing the guardian hidden inside the tower.', flags: ['surge_drawn'], quest: 'storm_lure', enemy: { hp: 50, atk: 4 } },
      { label: 'Take the warden’s route', result: 'Ivara opens a maintenance passage that avoids the strongest part of the storm.', flags: ['warden_route'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'steady_the_spire', name: 'STEADY THE SPIRE', npc: 'Warden Ivara', description: 'Repair the tower conductors.', objective: 'Choose “Repair the conductors” at Tempest Crown.', reward: { xp: 1650, zen: 1700 } },
      { id: 'lightning_map', name: 'THE LIGHTNING MAP', npc: 'Warden Ivara', description: 'Recover the map etched into the rods.', objective: 'Choose “Climb through the storm” at Tempest Crown.', reward: { xp: 1700, zen: 1650 } },
      { id: 'storm_lure', name: 'THE STORM LURE', npc: 'Warden Ivara', description: 'Reveal the guardian inside the tower.', objective: 'Choose “Draw the surge away” at Tempest Crown.', reward: { xp: 1800, zen: 1600 } }
    ]
  },
  {
    title: 'THE QUEEN OF ASHEN MIRRORS', place: 'Mirrorfall Court', npc: 'Knight Elowen',
    intro: [
      'The spire opens onto a court of black mirrors. Each pane shows a different version of the same battlefield, and one reflection moves before its owner does.',
      'Knight Elowen has been guarding the throne room while the mirror queen gathers the reflections into a single army.',
      'The throne lights up as you approach.'
    ],
    prompt: 'Elowen offers three ways forward: shatter the mirrors, challenge the queen, or turn the reflections against her.',
    choices: [
      { label: 'Shatter the outer mirrors', result: 'The reflected army loses its formation. The queen retreats behind the throne seal.', flags: ['mirror_ring_broken'], quest: 'shards_of_truth', enemy: { atk: -8 } },
      { label: 'Challenge the mirror queen', result: 'The queen accepts the challenge and steps out of the throne reflection.', flags: ['queen_challenged'], quest: 'court_of_ash', enemy: { hp: 65, atk: 6 } },
      { label: 'Turn the reflections against her', result: 'You redirect the mirror light. The reflected army turns on its source.', flags: ['reflections_reversed'], quest: 'reversed_court', enemy: { hp: -30 } },
      { label: 'Follow Elowen’s signal', result: 'Elowen leads you through a hidden passage beneath the court.', flags: ['elowen_signal'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'shards_of_truth', name: 'SHARDS OF TRUTH', npc: 'Knight Elowen', description: 'Break the outer mirrors protecting the throne.', objective: 'Choose “Shatter the outer mirrors” at Mirrorfall Court.', reward: { xp: 1950, zen: 1900 } },
      { id: 'court_of_ash', name: 'THE COURT OF ASH', npc: 'Knight Elowen', description: 'Challenge the Queen of Ashen Mirrors.', objective: 'Choose “Challenge the mirror queen” at Mirrorfall Court.', reward: { xp: 2200, zen: 1850 } },
      { id: 'reversed_court', name: 'THE REVERSED COURT', npc: 'Knight Elowen', description: 'Turn the mirror army against its queen.', objective: 'Choose “Turn the reflections against her” at Mirrorfall Court.', reward: { xp: 2050, zen: 2000 } }
    ]
  },
  {
    title: 'THE HOLLOW MERIDIAN', place: 'Meridian Engine', npc: 'Engineer Tal Ren',
    intro: [
      'A vast machine spans the chamber, its gears turning around an empty centre. The Meridian markings match the fracture you crossed on the earlier floors.',
      'Engineer Tal Ren believes the engine is pulling gates toward one another, compressing distant dungeons into the same space.',
      'The central gear begins to rotate in reverse.'
    ],
    prompt: 'Tal asks you to stop the reverse gear, isolate the power source, or let the engine complete one cycle.',
    choices: [
      { label: 'Stop the reverse gear', result: 'The machine slows and the chamber stabilises long enough to reach the next passage.', flags: ['meridian_stopped'], quest: 'gear_of_return', enemy: { atk: -9 } },
      { label: 'Isolate the power source', result: 'You disconnect a hidden source marked with the signature of the First Witness.', flags: ['meridian_source'], quest: 'witness_power', enemy: { hp: -30 } },
      { label: 'Allow one full cycle', result: 'The engine completes its turn and reveals a sealed chamber inside its centre.', flags: ['meridian_cycle'], quest: 'full_rotation', enemy: { hp: 55, atk: 5 } },
      { label: 'Break the outer controls', result: 'The controls collapse. Tal secures the route before the machine can restart.', flags: ['meridian_controls'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'gear_of_return', name: 'THE GEAR OF RETURN', npc: 'Tal Ren', description: 'Stop the Meridian Engine from reversing.', objective: 'Choose “Stop the reverse gear” at Meridian Engine.', reward: { xp: 2300, zen: 2200 } },
      { id: 'witness_power', name: 'THE WITNESS’ POWER', npc: 'Tal Ren', description: 'Find the engine’s hidden power source.', objective: 'Choose “Isolate the power source” at Meridian Engine.', reward: { xp: 2400, zen: 2100 } },
      { id: 'full_rotation', name: 'FULL ROTATION', npc: 'Tal Ren', description: 'Open the chamber within the engine.', objective: 'Choose “Allow one full cycle” at Meridian Engine.', reward: { xp: 2500, zen: 2050 } }
    ]
  },
  {
    title: 'THE ASTRAL RELIQUARY', place: 'Starfall Repository', npc: 'Seer Anwen',
    intro: [
      'The next gate reveals a repository floating above a field of stars. Shelves drift between islands of stone, each holding a memory from a different world.',
      'Seer Anwen has found a relic that records possible futures, but its pages are filling with events that have not happened.',
      'A constellation folds into the shape of a doorway.'
    ],
    prompt: 'Anwen asks you to seal the relic, read its newest page, or move the repository before the doorway opens.',
    choices: [
      { label: 'Seal the astral relic', result: 'The pages stop changing. Anwen records the seal sequence in your journal.', flags: ['astral_sealed'], quest: 'quiet_stars', enemy: { atk: -8 } },
      { label: 'Read the newest page', result: 'The page describes your arrival on the next floor and names the guardian waiting there.', flags: ['future_page'], quest: 'page_unwritten', enemy: { hp: -25 } },
      { label: 'Move the repository', result: 'You shift the star shelves away from the doorway, but the keeper follows the moving light.', flags: ['repository_moved'], quest: 'moving_archive', enemy: { hp: 60, atk: 5 } },
      { label: 'Ask Anwen to guide you', result: 'Anwen aligns the constellations and opens a safe route through the repository.', flags: ['anwen_guided'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'quiet_stars', name: 'QUIET THE STARS', npc: 'Seer Anwen', description: 'Seal the relic that records possible futures.', objective: 'Choose “Seal the astral relic” at Starfall Repository.', reward: { xp: 2600, zen: 2450 } },
      { id: 'page_unwritten', name: 'THE UNWRITTEN PAGE', npc: 'Seer Anwen', description: 'Read the newest future record.', objective: 'Choose “Read the newest page” at Starfall Repository.', reward: { xp: 2750, zen: 2350 } },
      { id: 'moving_archive', name: 'THE MOVING ARCHIVE', npc: 'Seer Anwen', description: 'Move the repository before its keeper arrives.', objective: 'Choose “Move the repository” at Starfall Repository.', reward: { xp: 2850, zen: 2300 } }
    ]
  },
  {
    title: 'THE SHATTERED CROWN', place: 'Crown of Fragments', npc: 'Commander Vael',
    intro: [
      'A crown hangs in pieces above a circular arena. Each fragment projects a different ruler over the same ruined kingdom.',
      'Commander Vael says the crown belonged to the first gate sovereign, and every fragment is trying to claim a different bearer.',
      'The arena floor divides into four shifting paths.'
    ],
    prompt: 'Vael asks you to gather the fragments, reject the crown, or choose one projection and confront it.',
    choices: [
      { label: 'Gather the crown fragments', result: 'The pieces stop fighting for control. Their combined light reveals a route beneath the arena.', flags: ['crown_gathered'], quest: 'broken_legacy', enemy: { hp: -30 } },
      { label: 'Reject the crown', result: 'The projections fade. The crown remains suspended, unable to bind itself to another hunter.', flags: ['crown_rejected'], quest: 'no_throne', enemy: { atk: -10 } },
      { label: 'Confront the strongest projection', result: 'The projection takes physical form and challenges you for the arena.', flags: ['projection_faced'], quest: 'false_sovereign', enemy: { hp: 70, atk: 6 } },
      { label: 'Let Vael choose the path', result: 'Vael marks a concealed passage that avoids the crown’s influence.', flags: ['vael_path'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'broken_legacy', name: 'A BROKEN LEGACY', npc: 'Commander Vael', description: 'Recover the crown fragments’ shared memory.', objective: 'Choose “Gather the crown fragments” at Crown of Fragments.', reward: { xp: 3000, zen: 2800 } },
      { id: 'no_throne', name: 'NO THRONE', npc: 'Commander Vael', description: 'Reject the crown and its projections.', objective: 'Choose “Reject the crown” at Crown of Fragments.', reward: { xp: 2950, zen: 2900 } },
      { id: 'false_sovereign', name: 'THE FALSE SOVEREIGN', npc: 'Commander Vael', description: 'Defeat the strongest crown projection.', objective: 'Choose “Confront the strongest projection” at Crown of Fragments.', reward: { xp: 3150, zen: 2750 } }
    ]
  },
  {
    title: 'THE LAST ECLIPSE', place: 'Eclipse Verge', npc: 'Keeper Solenne',
    intro: [
      'The light disappears at the edge of a silent plain. A dark eclipse hangs over the horizon, although no sun is visible.',
      'Keeper Solenne guards a final beacon that is keeping the eclipse from spreading into the lower floors.',
      'The beacon dims as a presence approaches from the dark.'
    ],
    prompt: 'Solenne asks you to relight the beacon, enter the eclipse, or protect the lower gate while she works.',
    choices: [
      { label: 'Relight the beacon', result: 'The beacon returns to full strength and the plain becomes visible again.', flags: ['eclipse_beacon'], quest: 'light_returned', enemy: { atk: -10 } },
      { label: 'Enter the eclipse', result: 'You cross the dark boundary and find a map of the final gate written in starlight.', flags: ['eclipse_entered'], quest: 'dark_map', enemy: { hp: -35 } },
      { label: 'Protect the lower gate', result: 'You hold the approach while Solenne restores the beacon. The eclipse guardian reveals itself.', flags: ['lower_gate_held'], quest: 'last_watch', enemy: { hp: 75, atk: 6 } },
      { label: 'Follow the fading light', result: 'The trail leads to a sealed stair beneath the plain. The final gate is below.', flags: ['fading_light'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'light_returned', name: 'LIGHT RETURNED', npc: 'Keeper Solenne', description: 'Restore the eclipse beacon.', objective: 'Choose “Relight the beacon” at Eclipse Verge.', reward: { xp: 3300, zen: 3150 } },
      { id: 'dark_map', name: 'THE DARK MAP', npc: 'Keeper Solenne', description: 'Recover the map hidden inside the eclipse.', objective: 'Choose “Enter the eclipse” at Eclipse Verge.', reward: { xp: 3450, zen: 3000 } },
      { id: 'last_watch', name: 'THE LAST WATCH', npc: 'Keeper Solenne', description: 'Protect the lower gate from the guardian.', objective: 'Choose “Protect the lower gate” at Eclipse Verge.', reward: { xp: 3550, zen: 2950 } }
    ]
  },
  {
    title: 'SOVEREIGN OF THE DEEP GATE', place: 'The Deep Gate', npc: 'The First Witness',
    intro: [
      'A final stair descends into a gate chamber larger than the citadel above. Its walls carry the marks of every floor, including the ones you have just crossed.',
      'The First Witness waits at the centre. The records you recovered have formed a complete map, and the gate is ready to open.',
      'A sovereign shape rises behind the sealed threshold.'
    ],
    prompt: 'The Witness offers a final decision: seal the gate, free the worlds beyond it, or challenge the sovereign guarding the threshold.',
    choices: [
      { label: 'Seal the deep gate', result: 'The threshold closes and the pressure across the lower floors fades. The Witness entrusts you with the seal record.', flags: ['deep_gate_sealed'], quest: 'final_seal', enemy: { atk: -12 } },
      { label: 'Free the worlds beyond', result: 'The gate opens without breaking. Light moves through the chamber and the trapped worlds begin to recover.', flags: ['worlds_freed'], quest: 'beyond_release', enemy: { hp: -40 } },
      { label: 'Challenge the deep sovereign', result: 'The guardian steps through the threshold. The final battle begins beneath the marks of all twenty floors.', flags: ['deep_sovereign_challenged'], quest: 'sovereign_fall', enemy: { hp: 90, atk: 8 } },
      { label: 'Ask the Witness for the truth', result: 'The Witness reveals that the gate was built to test whether its keeper would choose power or protection.', flags: ['witness_truth'], quest: null, enemy: {} }
    ],
    quests: [
      { id: 'final_seal', name: 'THE FINAL SEAL', npc: 'The First Witness', description: 'Close the Deep Gate permanently.', objective: 'Choose “Seal the deep gate” at The Deep Gate.', reward: { xp: 3900, zen: 3800 } },
      { id: 'beyond_release', name: 'BEYOND RELEASE', npc: 'The First Witness', description: 'Free the worlds held beyond the threshold.', objective: 'Choose “Free the worlds beyond” at The Deep Gate.', reward: { xp: 4050, zen: 3650 } },
      { id: 'sovereign_fall', name: 'THE SOVEREIGN’S FALL', npc: 'The First Witness', description: 'Defeat the guardian of the Deep Gate.', objective: 'Choose “Challenge the deep sovereign” at The Deep Gate.', reward: { xp: 4300, zen: 3500 } }
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
    'The Origin Gate bears a mark matching the System interface.',
    'The foundry control core contains a second command sequence beneath the ash.',
    'A lantern in the trench glows only when someone speaks a missing hunter’s name.',
    'The pale reliquary has one empty shelf with fresh dust beneath it.',
    'Lightning on the spire forms a map when the storm briefly pauses.',
    'The mirror court reflects a doorway that does not exist in the room.',
    'The Meridian Engine carries a gear stamped with the First Witness’s mark.',
    'A star chart in the repository changes when you record a new discovery.',
    'One crown fragment casts a shadow pointing toward the next gate.',
    'The eclipse plain holds footprints leading away from the beacon.',
    'The Deep Gate records the choices made on every floor before it.'
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
    'The evacuation list includes names that are not present in the refuge.',
    'The foundry relay was activated from beneath the floor, not from its control room.',
    'The trench lantern records contain one entry timestamped after its owner vanished.',
    'Neral’s missing name appears faintly on the back of the sealed shelf.',
    'The spire conductors were deliberately arranged to amplify the storm.',
    'Elowen’s notes identify the queen’s reflection as the original, not the copy.',
    'The Meridian Engine has a maintenance record signed by someone who was never born.',
    'Anwen’s newest page contains a blank line reserved for a choice not yet made.',
    'The crown fragments each contain a different version of the same royal oath.',
    'Solenne’s beacon log reports a signal from below the eclipse plain.',
    'The Deep Gate has a second seal hidden beneath the first witness mark.'
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
