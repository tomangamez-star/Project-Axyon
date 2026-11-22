# AXYON Guild System

Guild organisations are separate from the existing guild raid/duel/gauntlet combat engine. Guild records, membership, suggestions and group links are stored in PostgreSQL.

## Player commands

- `!guild` — show guild help and your current guild.
- `!guild list` — browse active guilds.
- `!guild info [id|tag]` — view a guild; without an argument, views your own.
- `!guild members [id|tag]` — view the roster.
- `!guild suggest <name> | <tag> | <description>` — send a proposal to AXYON. Each player may have one pending proposal. If approved, the suggester becomes the first leader.
- `!guild join <id|tag>` — join a guild. A player can belong to only one active guild at a time.
- `!guild leave` — leave a guild. Leaders must transfer leadership first.

## AXYON owner commands

- `!guild create <name> | <tag> | <description>` — create a guild. Mention a player in the same message to appoint them as leader; otherwise the owner becomes leader.
- `!guild group <id|tag>` — run inside a registered active WhatsApp group to link it to a guild. One guild per group and one group per guild.
- `!guild ungroup <id|tag>` — remove a guild's group link.
- `!guild leader <id|tag> @member` — transfer leadership to an existing member.
- `!guild disband <id|tag>` — disband a guild and release its members; the guild record remains in history.
- `!guild suggestions` — list pending proposals.
- `!guild approve <suggestion-id>` / `!guild reject <suggestion-id>` — review a proposal.

Group linking requires the WhatsApp group to be registered and active in AXYON. Once a guild is linked, members must join it from that group. Guild membership and WhatsApp group membership remain separate records. Existing room-based guild combat modes continue to use `src/axyon-guild.js` and are not replaced by this registry.
