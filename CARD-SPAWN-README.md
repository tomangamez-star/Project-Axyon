# AXYON Card System

## Player commands

- `!cards [page]` or `!card inventory [page]` — browse the complete owned collection in pages of 10.
- `!card <number>` — inspect one card.
- `!claim card <number>` — claim an AXYON-granted card.
- `!claim card #CODE` — claim a global drop; first database claimant wins.
- `!card equip <number> [1|2]` — equip a claimed card in either loadout slot.
- `!card unequip <1|2>` — free an equipment slot without deleting the card.
- `!card slots` — inspect the two battle slots.
- `!card abilities` — inspect ability counters for equipped cards.
- `!card use <1|2>` — use that equipped card ability during a battle.

Owned cards are unlimited. Only two may be equipped at once. The old `slot` column remains the stable collection number; the new `equipped_slot` column is independent. Existing claimed cards are migrated into the first two equipment slots per player where possible. Existing numbered grant claims remain compatible. Expired cards remain in the collection history but cannot be claimed, equipped, or used.

Each card has its own three-use ability counter per UTC day. Counters reset automatically at UTC midnight. The base damage of an equipped slot-1 card is added to normal attacks; using the card ability uses `ability_damage` as a separate combat bonus.

## AXYON management

`!cardadmin` is restricted to AXYON authority, including when the sender is in PLAYER mode.

- `!cardadmin create @player character | Name | Series | BaseDamage | Ability | AbilityDamage | Rating(1-6) | ExpiryDays(0=permanent) | ImageURL(optional)` (use `weapon` instead of `character` for a weapon card)
- `!cardadmin edit @player <number> <name|series|type|weapon|damage|ability|abilitydamage|rating|expiry> <value>`
- `!cardadmin art @player <number> <direct HTTPS image URL>`
- `!cardadmin delete @player <number>`
- `!cardadmin inspect @player <number>`
- `!cardadmin drops` and `!cardadmin cancel #CODE`
- `!spawncard` — owner-only manual global spawn.

Prices are not hard-coded; economy/shop pricing remains available for future AXYON configuration.

## Artwork sources

Danbooru is the primary source. A search asks the public `GET /posts.json` endpoint for `rating:g` posts, then filters locally for the exact character tag (or exact weapon general tag), supported static image formats and portrait dimensions. It records the post URL and artist tags for attribution. Public GET requests do not require an API key. Official API reference: https://danbooru.donmai.us/wiki_pages/help:api ; posts endpoint: https://danbooru.donmai.us/posts.json. An optional account can be configured with `DANBOORU_LOGIN` and `DANBOORU_API_KEY`; `DANBOORU_USER_ID` is used only to identify the client in its User-Agent. These are optional, not mandatory environment variables.

If a character is not found or Danbooru is unavailable, AXYON uses that same character's AniList portrait as the fallback. It does not silently substitute an unrelated character. For weapon cards without an exact safe Danbooru tag, AXYON requires a direct HTTPS image URL. Images are limited to 12 MB and JPEG, PNG or WebP.

Danbooru is a community-uploaded archive; `rating:g` is applied, but users should still review source permissions and creator attribution before redistributing any particular artwork.

## Renderer

Only the upgraded **Old Gen** renderer is used for new card creation and re-renders. Existing cards with a saved original `image_url` are upgraded automatically the first time a player opens them with `!card <number>`; if a legacy row has no reusable original-art URL, AXYON can replace it with `!cardadmin art @player <number> <direct HTTPS image URL>`. The other inherited renderer files remain in the repository for compatibility but are no longer randomly selected. Old Gen now extracts a dominant art colour, builds a complementary accent palette, fades the lower artwork into a tinted info panel, and prints card type, base damage, ability, ability damage, rating/rarity, expiry and the `⌬ AXYN CORE` watermark directly on the image.

## Automatic drops and persistence

The primary WhatsApp session checks PostgreSQL every minute and releases one global card when the six-hour timer is due. Automatically generated cards are valid for 30 days by default; set `AXYON_CARD_VALIDITY_DAYS=0` for permanent cards or a value from 1–3650 to change the validity window. The expiry is shown on the artwork and enforced when a user claims or equips/uses the card. The same code is broadcast to all enabled registered groups. Manual drops do not reset the automatic timer. The database locks a drop row on claim so only one user can win. Card images are stored as `BYTEA` so they remain available after the source file changes.

Existing PostgreSQL deployments migrate via `ensureSchema()` using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; no schema reset is required. `sharp` remains the image renderer dependency.


## Pinterest artwork through SerpApi

Automatic card drops now choose from the built-in anime character-variant catalogue and use SerpApi's Pinterest engine for portrait artwork. The selected portrait is downloaded and passed to the existing Old Gen card renderer; the renderer/template is unchanged. The saved card retains its Pinterest source link and pinner attribution when available.

Set these variables in Render → your service → Environment:

- `SERPAPI_API_KEY` — your private SerpApi key (required).
- `SERPAPI_REQUIRED=true` — makes card generation report a Pinterest/SerpApi error instead of silently switching to the legacy artwork providers.

The repository's `render.yaml` declares the secret as `sync: false`, so the key is not stored in source control. Never paste the key into code or commit it. Pinterest search results may include artwork owned by third parties; only use images you have permission to reproduce in generated cards and follow the applicable Pinterest and SerpApi terms.
