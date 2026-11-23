# AXYON floor campaign + AI Custom card enhancement

## Dynamic floor campaign
- `!floor [number]` now opens a chapter scene before the encounter.
- Five original chapter locations/NPCs rotate through the floor ladder: Mira Vale, Keeper Orin, Sable the Bellwright, Ren the Gate Cartographer, and Captain Ilyra.
- Each chapter presents four decisions. Use `!choice 1` through `!choice 4` to resolve the scene.
- Choices persist story flags, can change the upcoming enemy's HP/attack, and may unlock NPC side quests.
- `!battle` resumes the pending story decision if the player has not chosen yet; after the choice it resumes combat without replaying the introduction.
- `!quest` displays the journal. A quest becomes claimable after winning the encounter tied to its NPC choice. Use `!quest claim <id>` to collect XP and Zen.
- Story state is stored per player in PostgreSQL (`axyon_floor_story`).

## AI Custom card
- Removed the top nameplate so the portrait remains unobstructed.
- Rarity and rating remain compact in the upper corners.
- The star row spans the full card width between portrait and information panel.
- The information area is a dark gradient with the name and battle data below the artwork.
- Replaced the fixed image border with a code-drawn rounded/bevelled frame driven by sampled artwork colours.
- Restored the translucent gloss layer in the final PNG.
- Added `assets/card-particles.png`, a transparent particle/spark overlay tinted from the artwork palette. It is an effect layer only; it does not define the border.
- Portrait is clipped to rounded corners and rendered independently from the frame.
- Old Gen remains untouched and remains the automatic drop renderer.

## Commands
- `!floor [number]`
- `!choice <1-4>`
- `!battle`
- `!quest`
- `!quest claim <id>`

## Notes
- The chapter campaign is original content and currently provides five authored chapters; the chapter pattern cycles for floors beyond chapter five while the floor number continues to advance.
- Live WhatsApp button delivery remains unavailable in this repository's current command transport, so the story choices use a compact typed fallback (`!choice 1-4`).
- The new persistence table is created automatically by `ensureSchema()` at startup.
