# FlowMind

FlowMind is a workspace operations dashboard: AI agents, automation workflows, projects, approvals, an activity log, and a document knowledge base. Each signed-in user gets an isolated workspace backed by PostgreSQL, and AI features (command-center questions, project analysis, agent runs) use Google Gemini. Uploaded documents are text-extracted for agent context and stored privately, per owner.

For a walkthrough of each area of the app, see [USER_GUIDE.md](./USER_GUIDE.md). Security notes live in [SECURITY.md](./SECURITY.md).

## Tech stack

- Node.js 22 LTS and pnpm workspaces
- PostgreSQL with Drizzle ORM
- Express API server; React web app (Vite + Tailwind CSS)
- Google OAuth (OpenID Connect) for production sign-in
- S3-compatible object storage for uploads (Neon Object Storage in production)
- Google Gemini for AI features

## Local setup

Local development uses a single password-less dev account (`FLOWMIND_AUTH_MODE=local`), PostgreSQL from Docker Compose, and the filesystem storage adapter.

1. Install Node.js 22 LTS, pnpm 10, and Docker Desktop or Docker Engine.
2. Copy `.env.example` to `.env`.
3. Start PostgreSQL:

   ```sh
   docker compose up -d db
   ```

   Docker is optional if you already have a PostgreSQL 15+ server. In that case, change `DATABASE_URL` in `.env`.

4. Install workspace dependencies:

   ```sh
   pnpm install
   ```

5. Create/update the database schema:

   ```sh
   pnpm db:push
   ```

6. Start the API and web app:

   ```sh
   pnpm dev
   ```

7. Open <http://127.0.0.1:22473>. Sign-in uses the single local development account. Add a Gemini key to `.env` to use AI features; do not commit `.env`.

Local sign-in is intentionally weak and for development only. It is refused when `NODE_ENV=production`, and the dev server binds to `127.0.0.1`. Uploaded documents are stored under `data/`; PostgreSQL data is in the Docker volume `flowmind-postgres`.

## Free-tier production deployment

This walkthrough uses Render (web + API) and Neon (PostgreSQL + Object Storage), with Google OAuth for sign-in. Everything fits the free tiers. Step-by-step Neon details — click paths, exact values, and gotchas — are in [NEON_SETUP.md](./NEON_SETUP.md).

1. **Create a Neon project and copy the connection string.** In the Neon Console, create a project and copy the **pooled** connection string. It goes in `DATABASE_URL` (keep `?sslmode=require`). Details: [NEON_SETUP.md](./NEON_SETUP.md#1-create-a-neon-project).

2. **Enable Neon Object Storage and get S3 credentials.** In the same Neon project, enable Object Storage, create a bucket, and copy the endpoint, region, bucket name, and access keys. They map to `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, with `FLOWMIND_STORAGE_MODE=s3`. Details: [NEON_SETUP.md](./NEON_SETUP.md#2-enable-object-storage).

3. **Register a Google OAuth client.** In the Google Cloud Console (APIs & Services → Credentials), create an OAuth client ID of type **Web application** and add one authorized redirect URI that exactly matches `https://YOUR_DOMAIN/api/callback` (e.g. `https://flowmind.onrender.com/api/callback`). Copy the client ID and client secret into `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, keep `OIDC_ISSUER_URL=https://accounts.google.com`, and set `FLOWMIND_AUTH_MODE=oidc`. The callback URL is always derived from `PUBLIC_APP_URL`, so the two must match exactly.

4. **Deploy to Render.** Create a **Web Service** from your repository (or fork) and configure:

   - Build command: `pnpm install && pnpm build`
   - Start command: `pnpm start`
   - Health check path: `/api/healthz`
   - Environment variables (from `.env.production.example`, set in the dashboard): `DATABASE_URL`, `PUBLIC_APP_URL` (the final `https://…` URL), `CORS_ALLOWED_ORIGINS` (same origin), `FLOWMIND_AUTH_MODE=oidc`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `FLOWMIND_STORAGE_MODE=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `GEMINI_API_KEY`. Do not set `PORT`; Render provides it.

   Run the initial schema push once against Neon, from your machine:

   ```sh
   DATABASE_URL="paste-the-direct-neon-url" pnpm db:push
   ```

   Use the **direct** (non-pooled) connection string for `db:push`; the pooled string is for the running app.

   For the first deploy you can point `PUBLIC_APP_URL` at the Render-assigned `https://<service>.onrender.com` URL and register that redirect URI with Google; update both if you attach a custom domain.

5. **Free-tier caveats.**

   - Render free web services spin down after ~15 minutes without traffic; the next request takes up to about a minute while the service wakes.
   - Neon free PostgreSQL suspends compute when idle; the first query after a pause has a short wake-up latency.
   - Neon Object Storage's free tier includes 5 GB per project.
   - While the Google OAuth consent screen stays in **Testing** status, refresh tokens expire after 7 days and users must sign in again. Publish the app (still free) to remove this limit.

## Configuration

| Variable | Description |
| --- | --- |
| `NODE_ENV` | `production` enables the production guards and serves the built web app |
| `DATABASE_URL` | PostgreSQL connection string |
| `FLOWMIND_AUTH_MODE` | `local` (development only) or `oidc` |
| `LOCAL_DEV_EMAIL` | Email used for the local development account |
| `OIDC_ISSUER_URL` | OIDC issuer; `https://accounts.google.com` for Google |
| `OIDC_CLIENT_ID` | Google OAuth client ID |
| `OIDC_CLIENT_SECRET` | Google OAuth client secret |
| `PUBLIC_APP_URL` | Public origin of the app; OIDC callbacks derive from it |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins allowed by the API |
| `PORT` | API server port (production; Render provides it) |
| `FLOWMIND_WEB_PORT` | Local web dev server port |
| `API_PORT` | Local API port used by the dev proxy |
| `FLOWMIND_STORAGE_MODE` | `filesystem` or `s3` |
| `FLOWMIND_DATA_DIR` | Storage root for the filesystem adapter |
| `FLOWMIND_ALLOW_FILESYSTEM_STORAGE_IN_PRODUCTION` | Explicit `true` acknowledgement required to run filesystem storage in production |
| `S3_ENDPOINT` | S3-compatible endpoint URL (e.g. the Neon Object Storage branch endpoint) |
| `S3_REGION` | Region segment of the endpoint (e.g. `us-east-2`) |
| `S3_BUCKET` | Bucket that stores uploaded documents |
| `S3_ACCESS_KEY_ID` | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | S3 secret access key |
| `GEMINI_API_KEY` | Google Gemini API key for AI features |

## Useful commands

```sh
pnpm dev        # run the API and web app locally
pnpm typecheck
pnpm build
pnpm db:push    # apply the Drizzle schema to DATABASE_URL
pnpm start      # run the production build (reads .env.production if present)
```

Stop the app with Ctrl+C. Stop PostgreSQL with `docker compose down` (do **not** add `-v` unless you intend to delete the local database volume).

## Troubleshooting

- **Database connection fails:** confirm PostgreSQL is running (`docker compose ps`) and `DATABASE_URL` matches the local credentials.
- **Port already in use:** change `FLOWMIND_WEB_PORT` or `API_PORT` in `.env`.
- **AI features fail:** check that `GEMINI_API_KEY` is set and valid.
- **Google sign-in fails after deployment:** confirm `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`, that `PUBLIC_APP_URL` is the exact HTTPS origin, and that the authorized redirect URI in Google Cloud Console equals `${PUBLIC_APP_URL}/api/callback` character for character.
- **Uploads fail with `FLOWMIND_STORAGE_MODE=s3`:** verify all `S3_*` values (the endpoint must include `https://`) and that the bucket exists in the Neon project.
- **Uploaded files disappear after a redeploy:** you are running filesystem storage on an ephemeral disk; use `FLOWMIND_STORAGE_MODE=s3` instead.

## License
All rights reserved. This code is publicly visible for portfolio purposes only and may not be used, copied, or redistributed without permission.
