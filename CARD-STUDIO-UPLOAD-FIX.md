# Card Studio artwork upload fix

## What was wrong
The Card Studio browser code previously relied on a module-level `uploadedArtwork` value populated by the file input's asynchronous `change` handler. On mobile browsers, the preview/save action could run before that value was populated or restored, so the JSON request reached `normalizeStudioInput()` with both `imageData` and `imageUrl` empty. That matches the Render error at `src/dashboard.js` before rendering starts.

## Fix
- Preview, save, and AI-completion requests now read the actual selected file input at request time using `FileReader`.
- File type and 8 MB checks run at the point the request is prepared, and file-read errors are shown in the dashboard.
- The selected upload takes precedence over the optional URL field.
- The Card Studio script URL has a version query (`?v=2`) so browsers fetch the updated client script instead of reusing a cached copy.
- The server-side 8 MB validation, existing Old Gen renderer, `!spawncard`, and unrelated systems are unchanged.

## Deploy
Replace the project with this updated source (or apply the files in the patch archive), commit and deploy to Render. After deployment, reopen the dashboard and select the artwork again. The URL field can remain empty when a file is selected.

The fix has local syntax checks and the full automated test suite passing. It has not been verified against the user's live Render deployment or WhatsApp session.
