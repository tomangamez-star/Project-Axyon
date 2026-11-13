# ARCHITECT — WhatsApp RPG Engine

Architect is a command-and-button driven WhatsApp RPG built from the original WhatsApp bot repository and its existing RPG infrastructure. It keeps the game systems and operational foundation while removing conversational AI, model-provider calls, AI memory, and auto-reply personas.

## What is included

- Persistent player registration, wallet and bank economy, casino games, leaderboards, and profile views.
- Odyssey RPG progression, ranks, levels, XP, exploration, story chapters, missions, Masters, bond, training, skills, inventory, guilds, and turn-based combat.
- Card collection, card stats and decks, PvP duels, deterministic PvE opponents, and hybrid battles.
- Group-zone registration and command gating for Normal, Casino, Combat, Duels, and RPG City.
- WhatsApp pairing, multi-session management, reconnect/pause controls, session persistence, and a password-protected web dashboard.
- Optional music commands and existing bundled assets.

## AXYON — the Architect RPG

AXYON is the Solo Leveling–style progression layer. It is deterministic: no model is called anywhere in the RPG path.

- **Prefix** is `!` by default. AXYON can change it with `!prefix <symbol>`.
- **Registration** is `!arise`. That is the only way into the RPG — it does not require the legacy `/start` economy account.
- **Ranks** run `E → D → C → B → A → S → SS → SSS → Monarch`, advancing every 10 levels.
- **Grades** advance every 10 levels and grant **+15 HP** and **+4 ATK** each.
- **Power Energy** runs **50 → 220** across the ranks; a rank-up restores it in full.
- **Combat allowances**: self-heal **5 per combat**, class moves **3 per day**, card abilities **3 per day**.
- **Parties**: minimum **2**, default maximum **5** (AXYON can raise it).
- **Daily limits** cap XP and Zen per player per day; anything above the cap is discarded, not banked. Coins are separate and uncapped.
- **Duels** temporarily promote both fighters to WhatsApp group admin, then demote them when the duel ends.
- **Social requests** (bindings) require the other player's approval before they take effect.
- **Three original stages** cannot be removed — only edited or locked. Custom stages can be added, moved, locked and removed.
- **Mode-specific visuals** (image, GIF or clip) can be set per mode, with the `⌬ AXYN CORE` watermark on every message.

Run `!help` for the full index, or `!help <section>` for one of: `core`, `battle`, `dungeon`, `cards`, `social`, `economy`, `management`. Every implemented command is rendered from the same registry the router dispatches from, so help cannot drift from reality.

### Authority

| Identity | Function |
|---|---|
| **AXYON Mode** | Owner authority and management access |
| **PLAYER Mode** | Normal saved player progression and statistics |

Switching to PLAYER mode does **not** remove AXYON's management authority. Extra numbers are held in `AXYON_NUMBERS` (`!numbers add|remove|list`) so authority survives losing the owner's phone. **RHM** is a scoped management role that never overrides AXYON.

### Group registration

A group must be registered before Architect responds to ordinary commands there; unregistered groups are ignored. AXYON can bypass this and register groups (`!register`). This keeps random groups out of the RPG.

## Admin panel

`/dashboard` keeps the existing pairing flow untouched and adds an **Admin panel** below it, covering:

- **Groups** — pause/resume, per-group prefix, unregister
- **Players** — heal, adjust Zen, reset progression
- **Stages** and **Floors** — add, edit, lock/unlock, remove
- **Modes** — enable/disable, change max players
- **Visuals** — per-mode image/GIF/clip URL and caption
- **Authority** — grant/revoke AXYON numbers and RHM roles
- **Settings** — prefix, daily XP/Zen limits, party size, combat allowances, group gating
- **Audit log** — every management action, from WhatsApp and from the dashboard

The panel reuses the dashboard's password session and CSRF token; every write is audit-logged server-side.

## No conversational AI

Architect does not call Groq, OpenAI, Gemini, or another language-model provider. There are no free-chat AI personas, chat memory features, background auto-replies, or AI control settings. RPG opponents and NPC interactions are deterministic game logic; NPC and Master lines are scripted, while bond progression uses the existing cooldown-protected game function.

## Requirements

- Node.js 20 or newer (Render configuration pins Node 22.18.0).
- A PostgreSQL database, such as Supabase Postgres.
- A WhatsApp number to link with a pairing code.
- A strong `DASHBOARD_PASSWORD`.

## Environment variables

Copy `.env.example` to `.env` for local use, or set the variables in Render:

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `DASHBOARD_PASSWORD` | Yes | Password for `/dashboard`. |
| `WA_SESSION_ID` | No | Primary WhatsApp session ID; defaults to `architect-primary`. |
| `WA_MAX_SESSIONS` | No | Maximum linked WhatsApp accounts; defaults to `5`. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `LOG_LEVEL` | No | Pino log level; defaults to `info`. |
| `RYUDEN_COMMUNITY_URL` | No | Fallback invite URL for the Ryuden zone. |

## Install and run

```bash
npm ci
npm start
```

Open `https://YOUR-SERVICE.onrender.com/dashboard`, sign in, and generate a pairing code for the primary Architect account. On WhatsApp, open **Linked devices → Link with phone number** and enter the code. The dashboard can also pair additional Architect instances.

## Deploy on Render

The included `render.yaml` configures a Node web service. Create a new Render service from your fresh GitHub repository, set `DATABASE_URL` and `DASHBOARD_PASSWORD`, then deploy. The health endpoint is `/health`.

## Database compatibility note

The source foundation used legacy `rimuru_*` PostgreSQL table names. Those table identifiers are retained in this first Architect fork to avoid breaking the existing schema and migrations. A few legacy columns remain in the account and card tables for schema compatibility, but persona fields are blanked and card ratings are generated deterministically. Architect does not read old AI-memory or AI-conversation tables, and this fork does not delete old tables from an existing database. Use a fresh database for a clean Architect deployment; back up any old database before reusing it.

## Tests and checks

```bash
npm run check
node --test
```

`npm run check` validates the main server, dashboard, RPG, economy, card, duel, and UI modules.
