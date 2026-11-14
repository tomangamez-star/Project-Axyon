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

Open `/dashboard` and sign in with your **WhatsApp number**. AXYON sends a 7- or 8-digit code to that number privately; type it on the dashboard and you are in. There is no shared password any more — control of the number *is* the credential, so a code can be revoked per person and every level is distinguishable.

### Authority levels

| Level | Who | Can do |
|---|---|---|
| **admin** | The owner, `OWNER_NUMBERS`, and every number in `AXYON_NUMBERS` | Everything: pairing, sessions, economy, authority, settings |
| **rhm** | Numbers granted RHM (`!rhm add`) | Moderate groups, players, stages, floors, modes, visuals, audit log, feedback |
| **guest** | Any other number | Read-only game content: stages, floors, modes, shop catalogue, command list |

A guest never sees a phone number, a session, a player record, an authority list or the audit log. The permission table lives in `src/access.js`; every route names the permission it needs, so adding a level is one table edit.

### Sessions survive app switching

The session token is kept in `localStorage` as well as an HttpOnly cookie, and the screen you were on is remembered. Switching apps on a phone suspends the page rather than ending the session, so returning re-validates silently and puts you back where you were instead of showing the login screen again.

### Feedback

`/dashboard#feedback` (and `!feedback <message>` on WhatsApp) lets anyone message AXYON **without signing in**. The thread id is a random value the browser makes per tab and discards when the tab closes, so nothing identifies the sender. Staff with `feedback.read` see every conversation in the inbox and can reply.

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
| **Feedback** | Anonymous conversations, with replies |

Failures surface in a persistent banner as well as a toast — a button never fails silently.

## Music (`!play`)

`!play <song>` searches YouTube, shows the cover, and sends the **full track** as `audio/mpeg` named after the song.

YouTube refuses anonymous requests from datacenter IPs with *"Sign in to confirm you're not a bot"*. Three things are needed, and all three are wired in `src/music.js`:

1. **Cookies** — `data/cookies.txt` is committed (the repo is private). Override with `YTDLP_COOKIES_FILE` if you ever need to rotate it.
2. **A JavaScript runtime** — yt-dlp must solve YouTube's player challenge or it reports *"Only images are available for download"*. **Deno** is installed by `render-build.sh` and the `Dockerfile`; Node 20 is reported as unsupported by the solver.
3. **The `mweb` player client** — the default `web` client returns formats that 403 on the media fetch.

If YouTube still refuses, the Audius fallback serves full tracks. A missing Deno is reported honestly rather than silently degrading.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres. Required for the RPG, dashboard login and feedback. |
| `OWNER_NUMBERS` | Comma-separated phone numbers with AXYON authority. |
| `PORT` | HTTP port (default `3000`). |
| `WA_SESSION_ID` | Primary session id (default `architect-primary`). |
| `WA_MAX_SESSIONS` | Maximum paired accounts (default `5`). |
| `DASHBOARD_SESSION_HOURS` | How long a dashboard login lasts (default `720`). |
| `YTDLP_COOKIES_FILE` | Optional override for the committed YouTube cookie jar. |

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
