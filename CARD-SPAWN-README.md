# AXYON Card Spawn System

## Commands

- `!spawncard` — AXYON owner only. Generates one card and releases the same claim code to every registered, enabled AXYON group.
- `!claim card #CODE` — first successful claimant globally receives the card.
- `!cards` — shows the collection and sends saved card artwork.
- `!claim card 1` — the existing numbered-card claim flow remains available.

A player must have used `!arise` and must have a free card slot. The existing two-card limit is enforced during the claim transaction. Spawned cards are immediately marked claimed/active so the existing battle card action can use them. Manual spawning does not reset the six-hour automatic timer.

## Automatic spawning

The primary WhatsApp session checks the persistent PostgreSQL schedule once per minute. The first successful startup with at least one registered, enabled group can release the initial drop; later drops are released no more frequently than every six hours. If the service sleeps or restarts past its due time, it catches up on reconnect. Only one global drop is created per scheduled spawn, even though it is broadcast to multiple groups.

Claiming is atomic in PostgreSQL: the drop row is locked and only one user can be assigned as its owner. A duplicate claim receives an already-claimed response.

## Artwork pipeline

The three original Tempest/Rimuru renderers are included unchanged under `src/card-renderers/`:

1. `hunt-card.js`
2. `special-hunt-card.js`
3. `jtf-gen-card.js`

A renderer is selected for each drop. Character identity and the source portrait are retrieved from AniList; Sharp renders the card image. This AXYON integration does **not** claim to generate original AI artwork or reproduce the older bot's full fan-art discovery / verification pipeline. The AniList portrait is the artwork fallback/source for this implementation.

## Database and deployment

- `sharp` is now a direct dependency. Use `npm ci` / the normal Render build so the platform-specific Sharp binary is installed.
- Existing PostgreSQL deployments migrate automatically through `axyon-store.ensureSchema()`. New columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Card image bytes are stored in PostgreSQL (`BYTEA`) so a claimed card can still be displayed later without relying on the source image URL.
- No new environment variables are required. `DATABASE_URL` remains required for AXYON persistence.
