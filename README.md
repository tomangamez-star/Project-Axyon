# ARCHITECT — WhatsApp RPG Engine

Architect is a deterministic, command-driven WhatsApp RPG. There is **no AI anywhere in the game path** — every outcome is `Math.random()` plus fixed tables.

The bot has exactly **one** command system: **AXYON**, prefix `!`, registration `!arise`. There is no second router and no legacy fallback, so nothing from the previous build is reachable.

## Quick start

```
!register group normal   AXYON: authorize this WhatsApp group
!arise                   register your player profile
!help                    every command, grouped by section
!stages                  view Combat stages
!floor                   enter the Dungeon
!profile                 your rank, grade, stats and energy
```

## What is in the bot

- **AXYON RPG** — Solo Leveling–style progression: ranks, grades, Power Energy, stages, dungeon floors, parties, duels, cards, social bindings, Zen economy.
- **Admin panel** — a moderation surface in the web dashboard: groups, players, stages, floors, modes, visuals, authority, settings and an audit log. Every button is wired to a real endpoint.
- **Pairing and sessions** — WhatsApp pairing, multi-account session management, reconnect/pause, session persistence.
- **Output guard** — burst protection so the WhatsApp account is not rate-limited.

## AXYON — the RPG

- **Prefix** is `!` by default. AXYON can change it with `!prefix <symbol>`; a group can override it.
- **Group registration** is controlled only by AXYON and keyed by the WhatsApp group's JID. Register a group with `!register group normal`, `!register group modes` or `!register group duel`.
- **Player registration** is separate: each person uses `!arise` to create their saved RPG profile.
- **Group feature routing** replaces player-level `!mode`: Combat commands require the `combat` feature, Dungeon commands require `dungeon`, Duel commands require `duel`, and so on.
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

### Authority and group registration

Only verified AXYON identities can register groups or change their registration modes, statuses and features. WhatsApp group-admin status does not grant AXYON authority. `!register group modes` starts with no mode features enabled; AXYON can enable individual features with `!group enable <feature>`. `!register group duel` authorizes the Duel feature only.

Group management commands include `!register view`, `!register list`, `!register mode <normal|modes|duel>`, `!group info`, `!group features`, `!group enable|disable <feature>`, `!group suspend`, `!group reactivate`, and `!group remove`. Every registration mutation is audited. Removing a group does not delete player profiles. Extra AXYON numbers are held in `AXYON_NUMBERS` (`!numbers add|remove|list`) so authority survives losing the owner's phone. **RHM** is a scoped management role that never overrides AXYON. `!mode` has been removed; command access is group-based.

## Admin panel

Open `/dashboard` and sign in with your **WhatsApp number**. AXYON sends a 7- or 8-digit code to that number privately; type it on the dashboard and you are in. There is no shared password any more — control of the number *is* the credential, so a code can be revoked per person and every level is distinguishable.

### Authority levels

| Level | Who | Can do |
|---|---|---|
| **admin** | The owner, `OWNER_NUMBERS`, and every number in `AXYON_NUMBERS` | Everything: pairing, sessions, economy, authority, settings |
| **rhm** | Numbers granted RHM (`!rhm add`) | Moderate players, stages, floors, modes, visuals, audit log and feedback; cannot view or manage group registration |
| **guest** | Any other number | Read-only game content: stages, floors, modes, shop catalogue, command list |

A guest never sees a phone number, a session, a player record, an authority list or the audit log. The permission table lives in `src/access.js`; every route names the permission it needs, so adding a level is one table edit.

### Sessions survive app switching

The session token is kept in `localStorage` as well as an HttpOnly cookie, and the screen you were on is remembered. Switching apps on a phone suspends the page rather than ending the session, so returning re-validates silently and puts you back where you were instead of showing the login screen again.

### Feedback

`/dashboard#feedback` (and `!feedback <message>` on WhatsApp) lets anyone message AXYON **without signing in**. The thread id is a random value the browser makes per tab and discards when the tab closes, so nothing identifies the sender. Staff with `feedback.read` see every conversation in the inbox and can reply.

| Tab | What it does |
|---|---|
| **Groups** | View registration mode/features, pause, resume, set a per-group prefix, remove |
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

1. **Cookies** — provide a cookie jar through the `YTDLP_COOKIES_FILE` environment variable or an external secret mount. Never commit WhatsApp or browser cookies to the repository.
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
| `YTDLP_COOKIES_FILE` | Optional path to an externally managed YouTube cookie jar. |
| `GROQ_API_KEY` | Optional Groq API key for Card Studio AI completion. Required only for the “AI fill empty fields” action. |
| `GROQ_MODEL` | Optional Groq chat model override (default `llama-3.3-70b-versatile`). |

## Dashboard Card Studio

Card Studio lets an admin upload PNG, JPEG, GIF or WebP artwork (8 MB maximum), complete blank fields with Groq AI, preview with the existing Old Gen card renderer, save a card, and manually publish it to a WhatsApp group. Saved cards publish a six-character claim code; players use `!claim card #CODE`. Claims are unique per player and respect the configured claim limit and expiry. The random `!spawncard` flow remains independent.

To enable AI completion, add `GROQ_API_KEY` as a secret in the Render service environment. File upload, preview, save, manual publishing and claim tracking do not require the AI key.

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

## Guild organisations

AXYON now includes a persistent guild registry for creating guilds, suggesting guilds for owner review, joining/leaving, viewing rosters, transferring leadership and linking a guild to one registered WhatsApp group. See [GUILD-SYSTEM.md](GUILD-SYSTEM.md) for the complete command reference. The existing guild raid/duel/gauntlet combat engine remains separate and unchanged.

## Floor story campaign

`!floor [number]` now begins a chapter-based story encounter. Choose one of four decisions with `!choice 1` through `!choice 4`; choices alter the encounter and can unlock persistent NPC side quests. Use `!quest` to view the journal and `!quest claim <id>` to collect a completed reward after winning the linked floor battle. Story flags and quest state persist in PostgreSQL (`axyon_floor_story`). `!battle` resumes a pending story decision or the active fight without replaying the chapter introduction.

AI Custom cards use a rounded, dynamically palette-coloured code-drawn frame, a full-width star strip, a dark gradient data panel, baked-in gloss, and a tinted transparent particle PNG. Old Gen remains the automatic drop renderer.
