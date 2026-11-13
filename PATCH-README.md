# Architect patch — dashboard + linked-number commands

Target repository: `tomangamez-star/Project-Axyon`
Target branch at preparation: `main`

## Included replacements
- `public/dashboard.css` — replaces the Lily-like purple/pink visual treatment with Architect's black/cyan cyber-futuristic control-room styling. Existing HTML IDs and dashboard behavior are preserved.
- `src/message-guard.js` — permits recognized slash commands sent manually by the linked WhatsApp account (`fromMe`) while continuing to ignore its ordinary outgoing text. Existing registration, owner-only, and zone checks in the command pipeline remain in place.
- `test/message-guard.test.js` — regression tests for the own-number command path and ordinary outgoing message filtering.

## Apply
Extract this ZIP at the root of your Project-Axyon repository and allow it to overwrite the two existing files. Then run:

```bash
npm run check
node --test
```

No GitHub repository files are changed by this ZIP. The patch does not alter database schema, player data, pairing credentials, owner authorization, or zone restrictions.

## Important behavior
The connected number still needs to register with `/start` before using player commands. Owner-only actions remain owner-only, and zone-gated commands still require their configured group. The patch only removes the blanket `fromMe` text-command rejection for recognized commands.
