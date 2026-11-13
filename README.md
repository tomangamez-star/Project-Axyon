# ARCHITECT — WhatsApp RPG Engine

Architect is a deterministic, command-driven WhatsApp RPG. There is **no AI anywhere in the game path** — every outcome is `Math.random()` plus fixed tables.

The bot has exactly **one** command system: **AXYON**, prefix `!`, registration `!arise`. There is no second router and no legacy fallback, so nothing from the previous build is reachable.

## Quick start

```
!arise          register and awaken
!help           every command, grouped by section
!stages         pick a fight
!profile        your rank, grade, stats and energy
```

## What is in the bot

- **AXYON RPG** — Solo Leveling–style progression: ranks, grades, Power Energy, stages, dungeon floors, parties, duels, cards, social bindings, Zen economy.
- **Admin panel** — a moderation surface in the web dashboard: groups, players, stages, floors, modes, visuals, authority, settings and an audit log. Every button is wired to a real endpoint.
- **Pairing and sessions** — WhatsApp pairing, multi-account session management, reconnect/pause, session persistence.
- **Output guard** — burst protection so the WhatsApp account is not rate-limited.

## AXYON — the RPG

- **Prefix** is `!` by default. AXYON can change it with `!prefix <symbol>`; a group can override it.
- **Registration** is `!arise`. It is the only way in, and it is the only command that works before registering.
- **Ranks** run `E → D → C → B → A → S → SS → SSS → Monarch`, advancing every 10 levels.
- **Grades** advance every 10 levels and grant **+15 HP** and **+4 ATK** each.
- **Power Energy** runs **50 → 220** across the ranks; a rank-up restores it in full.
- **Combat allowances**: self-heal **5 per combat**, class moves **3 per day**, card abilities **3 per day**.
- **Parties**: minimum **2**, default maximum **5** (AXYON can raise it).
- **Daily limits** cap XP and Zen per player per day; anything above the cap is discarded, not banked.
- **Duels** temporarily promote both fighters to WhatsApp group admin, then demote them when the duel ends.
- **Social requests** (bindings) require the other player's approval before they take effect.
- **Three original stages** cannot be removed — only edited or locked. Custom stages can be added, moved, locked and removed.
- **Mode-specific visuals** (image, GIF or clip) can be set per mode, with the `⌬ AXYN CORE` watermark on every message.

Run `!help` for the full index, or `!help <section>` for one of: `core`, `battle`, `dungeon`, `cards`, `social`, `economy`, `management`. Help is rendered from the same registry the router dispatches from, so it cannot drift from reality.

### Buttons

Most of the bot is plain commands. Buttons appear in exactly two places, where tapping genuinely beats typing:

- the **six battle actions** (`!attack`, `!class`, `!heal`, `!carduse`, `!guard`, `!retreat` all work as text too)
- **accept / decline** on a duel challenge (`!duel accept <id>` / `!duel decline <id>` also work)

Every other screen is text.

### Authority

| Identity | Function |
|---|---|
| **AXYON Mode** | Owner authority and management access |
| **PLAYER Mode** | Normal saved player progression and statistics |

Switching to PLAYER mode does **not** remove AXYON's management authority. Extra numbers are held in `AXYON_NUMBERS` (`!numbers add|remove|list`) so authority survives losing the owner's phone. **RHM** is a scoped management role that never overrides AXYON.

## Admin panel

Open `/dashboard`, sign in with `DASHBOARD_PASSWORD`, and the panel appears below the pairing controls. It reuses the dashboard's password session and CSRF protection; every write is audit-logged.

| Tab | What it does |
|---|---|
| **Groups** | Pause, resume, set a per-group prefix, unregister |
| **Players** | Heal, adjust Zen, clear a stuck battle, reset progression |
| **Stages** | Add, edit, lock, unlock, remove (originals are protected) |
| **Floors** | Add, edit, lock, unlock, remove dungeon floors |
| **Modes** | Enable/disable duel, solo, multiplayer, party; set max players |
| **Visuals** | Set or clear the image/GIF/clip per mode |
| **Authority** | Grant or revoke AXYON numbers and RHM roles |
| **Settings** | Prefix, daily XP/Zen limits, party bounds, combat allowances, group gating, duel auto-promote |
| **Audit log** | Every management action, with actor and target |

Failures surface in a persistent banner as well as a toast — a button never fails silently.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres. Required for the RPG and for session persistence. |
| `DASHBOARD_PASSWORD` | Dashboard sign-in. Without it the dashboard refuses to log anyone in. |
| `OWNER_NUMBERS` | Comma-separated phone numbers with AXYON authority. |
| `PORT` | HTTP port (default `3000`). |
| `WA_SESSION_ID` | Primary session id (default `architect-primary`). |
| `WA_MAX_SESSIONS` | Maximum paired accounts (default `5`). |

## Development

```bash
npm install
npm run check     # syntax-check every source and browser file
npm test          # unit tests
```

### End-to-end harness

`tools/e2e.js` boots the real command router and the real dashboard HTTP handler against a real Postgres database and drives them the way WhatsApp and a browser would: a fake socket records every outgoing message, messages are fed in as both `fromMe: true` and `fromMe: false` in groups and DMs, and the dashboard is exercised over real HTTP with a real login, real CSRF and real cookies.

```bash
DATABASE_URL=postgres://postgres@localhost:5432/axyon_test \
DASHBOARD_PASSWORD=test-pass \
node tools/e2e.js
```

It covers the reported `fromMe` bug, every command, the registration gate, dead legacy commands, button policy, battle actions, button taps, group gating, prefix changes, duels with real admin promotion, and every dashboard action including CSRF rejection and invalid input.

## Layout

```
src/
  server.js          WhatsApp entry point, one message path
  message-guard.js   decides what is worth routing (prefix-driven, not list-driven)
  identity.js        sender resolution, LID mapping, command parsing
  axyon-rpg.js       progression, combat, duels, cards, economy
  axyon-commands.js  the command registry and router
  axyon-admin.js     moderation API behind the dashboard
  axyon-store.js     Postgres persistence (axyon_* tables)
  greetings.js       arrival and return copy
  dashboard.js       HTTP routes, auth, CSRF
  auth-store.js      pairing credentials and session storage
  account-config.js  per-account settings
  instance-lease.js  single-owner protection
public/
  dashboard.html     dashboard shell
  dashboard.js       pairing and instance controls
  admin.js           admin panel
tools/
  e2e.js             end-to-end harness
```
