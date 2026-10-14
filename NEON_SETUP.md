# Neon setup

Step-by-step Neon configuration for FlowMind: one PostgreSQL project and one Object Storage bucket, both on the free tier. The Neon Console changes occasionally, so labels may differ slightly from the ones below.

## 1. Create a Neon project

1. Sign up at <https://neon.com> (GitHub or Google sign-in works; no card required on the free plan).
2. In the Console, choose **Create project** and fill in:
   - **Name:** `flowmind` (or anything you like)
   - **Postgres version:** the default (17) is fine — FlowMind needs 15+ **with the pgvector extension** (available on all Neon plans, including free)
   - **Region:** pick one close to where you will host the web app
   - Leave the default branch (`main`) and database (`neondb`).
3. Open the project. The **Connection string** panel is on the project dashboard (sometimes behind a **Connect** button).

### Copy the connection string

In the connection panel, select:

- **Branch:** `main` (default)
- **Database:** `neondb` (default)
- **Role:** the default owner role
- **Connection type:** **Pooled connection**

Copy the pooled string, which looks like:

```
postgresql://<user>:<password>@<endpoint>-pooler.<region>.aws.neon.tech/neondb?sslmode=require
```

Then:

- Paste it into `.env.production` as `DATABASE_URL` (on Render, set it in the dashboard).
- Run the schema push once from your machine, using the **direct** (non-pooled) string — take the pooled URL and remove `-pooler` from the host:

```sh
DATABASE_URL="postgresql://...aws.neon.tech/neondb?sslmode=require" pnpm db:push
```

`pnpm db:push` runs `CREATE EXTENSION IF NOT EXISTS vector` first, so document embeddings work on Neon out of the box — no manual extension step is needed.

## 2. Enable Object Storage

1. In the Console open your project and find **Object Storage** in the project sidebar (a beta feature; it may be listed under a separate tab).
2. Enable Object Storage for the project — one click, no card required.
3. Create a bucket for document uploads:
   - **Name:** `flowmind-documents` (or anything)
   - Keep the bucket **private**. FlowMind enforces per-owner access itself: every read and delete goes through an ACL-checked API route, and uploads are bound to a short-lived, owner-scoped URL.
4. From the bucket/credentials panel, copy these values:

| Value | Looks like |
| --- | --- |
| **Endpoint** | `https://<branch-id>.storage.<cell>.<region>.aws.neon.tech` |
| **Region** | the region segment of the hostname, e.g. `us-east-2` |
| **Access key ID** | an S3-style key ID |
| **Secret access key** | the matching secret (if the Console shows it only once, store it somewhere safe) |

Valid regions include `us-east-1`, `us-east-2`, `eu-central-1`, and `ap-southeast-1` — use the one that appears in your endpoint.

## 3. Where each value goes

In `.env.production` (or the equivalent environment variables on your host):

| Neon value | Variable |
| --- | --- |
| Pooled connection string | `DATABASE_URL` |
| Endpoint (full `https://` URL) | `S3_ENDPOINT` |
| Region (`us-east-2`, …) | `S3_REGION` |
| Bucket name | `S3_BUCKET` |
| Access key ID | `S3_ACCESS_KEY_ID` |
| Secret access key | `S3_SECRET_ACCESS_KEY` |

Also set `FLOWMIND_STORAGE_MODE=s3`. A complete example is in [`.env.production.example`](./.env.production.example); the deployment walkthrough is in [README.md](./README.md#free-tier-production-deployment).

## Gotchas

- **Pooled vs direct connection:** the running app should use the pooled (`-pooler`) `DATABASE_URL`; `pnpm db:push` is more reliable against the direct URL. Both point at the same database.
- **SSL:** keep `?sslmode=require` in `DATABASE_URL`. Neon refuses non-TLS connections, and the app does not add SSL parameters on its own.
- **Idle behavior (scale to zero):** on the free plan, Postgres compute suspends after a few idle minutes. The first query after a pause wakes it (brief delay; an occasional retry may be needed). Neon Object Storage's free tier includes 5 GB per project.
- **pgvector:** the document-embedding feature needs the `vector` extension. Neon supports it on every plan; `pnpm db:push` enables it automatically (the command must be run by a role that can create extensions — the project owner works).
- **Object Storage is branch-scoped:** each branch has its own buckets and endpoint. Files uploaded through the `main` endpoint are not visible from another branch, so point the app at one branch's endpoint and keep it stable.
- **Use the endpoint exactly as shown:** include `https://`, do not append the bucket name, and do not switch to virtual-hosted-style addressing — FlowMind already uses path-style URLs, which Neon requires.
- **Region format:** use the region segment from the endpoint (`us-east-2`), not the project's API region label (`aws-us-east-2`).
