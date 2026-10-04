# Cloudflare Pages

Create a Pages project from this repository with the repository root as the project root. Use `npm run build` as the build command and `dist` as the output directory. `wrangler.jsonc` contains the Pages output configuration, and the build requires Node.js `20.19+` or `22.12+`.

The Pages Functions are `/api/github-sync` and `/api/submit-data`. Configure these bindings in the Pages project settings:

- Add `GITHUB_TOKEN` as a secret. `GITHUB_REPOSITORY` and `GITHUB_BRANCH` are optional variables; they default to `deodatusmaliti/SiaraMaina-Clan-Informatics-New` and `main`.
- Bind a Cloudflare D1 database as `DB` for `/api/submit-data`. Create an `entries` table with `name` and `content` columns before using that endpoint. It returns `503` until the binding is configured.

Pages hosts the static frontend and these two functions. The larger `/api/db/*`, metrics, and WebSocket API still runs in the Node backend (`server.ts`); it is not part of this Pages deployment. The frontend defaults to its existing backend URL and supports overriding it with the `clan_custom_backend_url` browser local-storage setting.
