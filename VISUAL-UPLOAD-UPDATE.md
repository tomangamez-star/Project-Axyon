# Architect dashboard visual uploads

This update replaces the dashboard's external image URL field with a phone-friendly image picker.

## Install

Copy the included files into the matching paths in your Project-Axyon repository, overwriting those files, then redeploy.

## Use

1. Open Architect Control > Visuals.
2. Choose the visual type (for example, `arise / welcome`).
3. Tap the image picker and choose a JPG, PNG, WEBP, or GIF from your phone.
4. Optionally enter a caption, then tap **Upload & set visual**.

Images are validated by file signature and limited to 8 MB. The image bytes and MIME type are stored in the existing PostgreSQL database, not on the app's temporary filesystem, so they survive redeploys. The dashboard's schema setup adds the required columns automatically.

Existing URL-based visuals remain usable until replaced or removed. New dashboard uploads use database-stored image bytes.

## Files

- `src/dashboard.js` — authenticated, CSRF-protected multipart upload endpoint and image validation.
- `src/axyon-store.js` — persistent image storage in PostgreSQL.
- `src/axyon-admin.js` — reports whether a visual has an uploaded image without sending image bytes to the browser.
- `src/axyon-rpg.js` — sends stored image bytes to WhatsApp.
- `public/admin.js` — mobile image picker and upload UI.
- `test/visual-upload.test.js` — upload parsing and image-signature tests.
