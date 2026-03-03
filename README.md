# Figma to Klaviyo (Rebuild)

This is a cleaned, runnable rebuild of your 1-hour prototype:
- Figma plugin (`teams/`) for frame preview, auto-suggested slices, manual slice editing, and upload trigger
- Backend (`backend/`) for slice extraction, compression, and Klaviyo image upload

## Backend

```bash
cd backend
npm install
npm run dev
```

Set these env vars (local or Railway):

- `PORT=3000`
- `KLAVIYO_ACCOUNTS=default,brand2` (optional, comma-separated order)
- `KLAVIYO_API_KEY_DEFAULT=...`
- `KLAVIYO_ACCOUNT_NAME_DEFAULT=Default`
- `KLAVIYO_API_KEY_BRAND2=...` (optional)
- `KLAVIYO_ACCOUNT_NAME_BRAND2=Brand 2` (optional)

## Plugin (Figma)

1. In Figma Desktop: `Plugins -> Development -> Import plugin from manifest...`
2. Select: `teams/manifest.json`
3. In plugin UI:
   - Set `Backend URL` (`http://localhost:3000` local or Railway URL)
   - Click `Load Accounts`
   - Select a frame, load preview, create slices, upload

## Notes

- Slices are prevented from overlapping (touching edges is allowed).
- Backend exports and compresses each slice, then uploads to Klaviyo Images API.
