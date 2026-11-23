# AXYN CORE — Duel, Profile, Purge & Architect Conversation Patch

Base: `Project-Axyon-adventure-collab-full.zip` (23 Nov 2026)

## Changes

- **Duel mentions:** resolve WhatsApp LID mentions through Baileys' LID-to-phone mapping before looking up the registered player. An unmapped LID is rejected safely instead of being mistaken for a phone-number player ID. Applied to direct `!duel @player` and `!duel invite @player`.
- **Profile display:** replaced the fixed-width framed profile with a narrow vertical layout. Vital stats, short bars, combat values and holdings each occupy readable lines for WhatsApp mobile.
- **Global progression reset:** added owner-only `!purge` and alias `!resetall`. `!reset all` is also supported. Each requires an explicit `confirm` argument. It resets all player progression, class mastery/usage and active battles while preserving registrations, player names, cards, guilds and saved adventure records. The action is audit-logged.
- **Architect personality:** changed the system prompt to a relaxed, confident, dry-humoured conversational style. No `AI:` label, creator credits, canned help greeting, unsolicited AXYON/game talk, or boilerplate command disclaimer in ordinary replies.
- **Conversation context:** keeps a bounded short-term thread per chat and player, and includes the quoted message text when someone replies to Architect so follow-ups retain their reference.
- **Duel battle access:** restored shared `!fight` and battle-action access in Duel-only groups as well as Combat/Dungeon groups.

## Commands

- `!purge` — show the global reset warning and affected player count.
- `!purge confirm` — execute the owner-only global progression reset.
- `!resetall` / `!resetall confirm` — alias for the same operation.
- `!reset all` / `!reset all confirm` — alternate syntax.

## Validation

- `npm run check`: passed.
- Focused tests for identity resolution, Architect prompt, command registration and profile formatting: passed.
- Full suite: 294 passed, 5 failed. Remaining failures are in untouched Card Studio static checks (`test/card-studio.test.js`, 3) and visual-upload test exports (`test/visual-upload.test.js`, 2). The previously failing Duel-only `!fight` checks now pass.
- No live WhatsApp session or production database was available, so live mention resolution and the destructive reset were not executed against real user data.
