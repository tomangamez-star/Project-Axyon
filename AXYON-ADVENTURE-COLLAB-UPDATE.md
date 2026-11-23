# AXYON Adventure Directory and Collaboration Update

## Compatibility promise

This update is additive. It preserves the existing personal `!floor` story flow, the four-choice `!choice` interaction, the original no-argument `!story` lore response, and existing direct `!duel @player` challenges. New multiplayer campaign story state lives on room sessions and does not overwrite a player's personal floor-story state.

The new `!mode` directory is separate from the older `!modes` administration/configuration command.

## Adventure directory

### Modes

- `!mode` / `!mode list` / `!mode help`
- `!mode info <mode>`
- `!mode enter <mode>` / `!mode start <mode>`
- `!mode status` / `!mode locks`
- `!mode lock <mode|all>` / `!mode unlock <mode|all>`
- `!mode lock info <mode>` / `!mode lock reason <mode> <reason>`
- `!mode leave` / `!mode logout <mode>`
- `!mode login <save-code>`
- `!mode save [progress|code|status] [mode]`
- `!mode progress` / `!mode checkpoint`

Modes are `solo`, `multiplayer` (also accepts `party`), `guild`, `duel`, and `abyss`. Mode capacity metadata is Solo 1, Multiplayer 3, Guild 5, Duel 2, and Abyss up to 5 depending on its selected session type.

Existing systems are reused where they already exist:
- Solo routes through the existing personal `!floor` / floor-story and battle engine.
- Multiplayer uses the existing Party and room-session lifecycle.
- Guild uses the existing guild squad and verified guild membership/group.
- Duel Chronicles use a separate room-session path; legacy direct player duels remain available.
- Abyss uses the room-session infrastructure with an Abyss mode identity.

### Solo and shared room sessions

Solo shortcuts include `!solo start`, `continue`, `story`, `progress`, `chapter`, `floor`, `explore`, `investigate`, `mission`, `objectives`, `map`, `inventory`, `rewards`, `checkpoint`, `save`, `logout`, and `login`.

Room-based campaigns use `!session status|members|save|leave|resume|code` plus shared story actions such as `!session story`, `!session choose <1-4>`, `!session explore`, `!session investigate`, `!session talk <character>`, `!session recap`, `!session objectives`, and `!session map`.

Shared campaign story state is stored inside the room state using a row-locked database mutation. It reuses the existing floor-story decision content; it is not a separate replacement for personal `!floor`.

### Party, Guild and Duel

Existing party and guild squad commands have been extended with invitations, post-launch management, ready/start/resume/rejoin, save/login/logout and status helpers. The limits are 3 for parties and 5 for guild squads. Guild Campaign access checks the player's current membership against the same linked guild.

Duel Chronicles have their own invite/accept/decline/start and room-based save/restore path. Existing direct duel ID-based accept/decline and `!duel @player` are not replaced.

### Adventure and combat aliases

The update adds shortcut/help routes for `!continue`, `!explore`, `!investigate`, `!talk`, `!interact`, `!mission`, `!objectives`, `!map`, `!location`, `!discoveries`, `!checkpoint`, `!boss`, `!rewards`, `!moves`, `!move`, `!target`, `!targets`, `!hp`, `!energy`, and `!cooldowns`, reusing current player, story, inventory and combat state.

Not every requested directory label represents a separate game mechanic:
- The current combat implementation remains single-target; `!target` reports the available target rather than adding multi-target combat.
- There is no weapon-specific action engine; `!weapon` reports that weapon actions remain tied to the existing combat implementation.
- Story choices currently use typed numbered commands; native WhatsApp interactive-button transport is not added here.
- Abyss `events` currently reflects the active story history; it does not yet have an independent random-event scheduler/table.
- `!treasure` and other loot views use existing discoveries/inventory; there is no separate treasure simulation.

## Save codes and locks

Adventure saves and mode locks use PostgreSQL tables from `src/axyon-adventure.js`. Save codes use the `AX-SOLO-`, `AX-PARTY-`, `AX-GUILD-`, `AX-DUEL-`, or `AX-ABYSS-` prefix followed by six uppercase hexadecimal characters.

A save code is an identifier, not proof of ownership. Login checks the requester identity and, for team campaigns, the existing room/session and relevant guild/group membership. Player-wide profile progression remains authoritative in the existing player database; restoring a session does not rewind a player's global stats, wallet or inventory.

Mode lock controls require the existing AXYON/RHM authority checks. Locks block new entry/login while preserving saved data.

## Cosmetic skin foundation

`!skin list|current|equip|unequip|inventory` and `!appearance` are backed by `axyon_player_skins`. The current update stores ownership/equipped state only.

The following are not yet connected: rendered skin artwork, `!skin preview`, skin-specific visual effects, and `!appearance view @username`. The skin system is cosmetic and does not alter HP or damage.

## Cross-group collaboration system

The uploaded Architect collaboration package was adapted to AXYON's database and group-registration model; its standalone in-memory `globalThis` registry was not copied.

### Commands

- `!collab list`
- `!collab create <title> | <description>`
- `!collab info <id>`
- `!collab submit <id>` / `!collab approve <id>`
- `!collab start|pause|resume|end|cancel <id>`
- `!collab group add|remove <id>` (run inside the group being linked/unlinked)
- `!collab join|leave <id>` (from a participating registered group)
- `!collab event list <id>`
- `!collab event add <id> <title> | <description> | <starts-at> | <ends-at>`
- `!collab mission list <id>`
- `!collab mission add <id> <title> | <description> | <points>`
- `!collab mission submit <mission-id>`
- `!collab mission review <mission-id> <user-id> <approve|reject>`
- `!collab reward list <id>`
- `!collab reward add <id> <name> | <description> | <points-required> | <quantity>`
- `!collab reward claim <reward-id>`
- `!collab stats <id>` / `!collab leaderboard <id>`

Participating WhatsApp groups must already be registered with the `collab` feature. Linking/unlinking is performed from the target group by a live-verified group admin. Each group can attach itself; doing so does not grant that group's admin collaboration-management rights. Campaign management remains restricted to its creator and configured authority. Starting/resuming rechecks that all linked groups remain active and registered with the collab feature.

The database-backed implementation has lifecycle controls, group participants, events, mission submissions/review, point balances, reward claims, statistics, leaderboard and audit rows. Scheduled event reminders/automatic broadcast delivery are not yet implemented; events are stored and listed.

## Explicitly not included

- No replacement of the existing `!floor`, `!choice`, personal story journal or `!story` lore response.
- No new standalone combat engine, damage formula, economy, progression system or inventory database.
- No production WhatsApp button transport, scheduled notifications, weapon-specific combat, multi-target selection or visual skin renderer.
- Lyrics command is not changed.

## Verification performed

- `npm run check` — passed.
- Focused tests for `axyon-adventure`, `axyon-collab`, and `floor-story` — 11 passed.
- Full `node --test` run — 286 passed, 7 failed. The failures are existing/stale Card Studio asset/expectation checks, two existing fight feature-gate expectations for groups registered without the `combat` feature, and two visual-upload test helper export expectations.
- No live `DATABASE_URL` migration, production PostgreSQL test, or live WhatsApp metadata/invitation/session test was run.
