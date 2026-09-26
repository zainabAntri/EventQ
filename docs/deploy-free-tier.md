# Free-tier deployment (Vercel + Render + Supabase)

A $0 way to run the whole product on the public internet: web on Vercel, API
and Redis on Render's free tier, Postgres on Supabase's free tier. No AWS, AI
off. This is for demos and end-to-end testing; the production target is still
the ECS/RDS layout in [architecture.md](architecture.md) §16.

## Why a proxy

The auth cookies are `SameSite=Lax` and host-only (`apps/api/.../auth.cookies.ts`).
A browser on `event-q-web.vercel.app` will never send them to `*.onrender.com`,
so the web app proxies `/api/v1/*` and `/health/*` to the API via Next rewrites
(`apps/web/next.config.ts`, gated on `API_PROXY_TARGET`). The browser only ever
sees one origin; cookies, CORS and the CSRF header all work unchanged.

## What the API actually needs

| Service                                       | Required?                                                    | Free option      |
| --------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| Postgres with `vector`, `pg_trgm`, `pgcrypto` | yes                                                          | Supabase         |
| Redis                                         | yes in production — the rate limiter fails closed without it | Render Key Value |
| S3                                            | no — config only, nothing reads it                           | dummy values     |
| Anthropic                                     | no — `AI_ENABLED=false`                                      | —                |

## Steps

### 1. Supabase

1. Create a free project. Pick the same region you will use on Render.
2. Connect → **Session pooler** (port 5432, host `aws-0-<region>.pooler.supabase.com`).
   Not the direct connection: it is IPv6-only on the free plan and Render's
   egress is IPv4-only.
3. Nothing to enable by hand — the init migration creates the extensions.

Free projects pause after 7 idle days; restore from the dashboard.

### 2. Migrate and seed from your machine

One-off and gated, which is what [migrations.md](migrations.md) asks for.

```bash
DATABASE_URL='<session pooler url>' pnpm db:deploy
DATABASE_URL='<session pooler url>' SEED_PASSWORD='<12+ chars>' pnpm db:seed   # optional demo data
```

The inline variable wins over `apps/api/.env` (`process.loadEnvFile` does not
overwrite existing variables). The seed refuses only when `NODE_ENV=production`,
which your shell is not. Instead of seeding you can register a real account
against the live API: `POST /api/v1/auth/register`.

### 3. Render

**Key Value** (Redis) first: New → Key Value, free plan. Copy the **internal**
URL (`redis://red-…:6379`).

**Web Service**: New → Web Service from the GitHub repo, free plan.

| Setting           | Value                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Root directory    | _(blank — the pnpm workspace lives at the repo root)_                                                 |
| Build command     | `corepack enable && pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=@eventq/api` |
| Start command     | `pnpm --filter @eventq/api start`                                                                     |
| Health check path | `/health/live`                                                                                        |

`--filter=@eventq/api` still builds `packages/contracts` first (turbo `^build`)
but keeps the web build — which needs `NEXT_PUBLIC_*` — out of this service.

Environment variables:

| Key                                                     | Value                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `NODE_VERSION`                                          | `22`                                                                  |
| `NODE_ENV`                                              | `production`                                                          |
| `API_PORT`                                              | `10000` — Render's default port; the app reads `API_PORT`, not `PORT` |
| `DATABASE_URL`                                          | Supabase session pooler URL                                           |
| `REDIS_URL`                                             | Render Key Value internal URL                                         |
| `WEB_ORIGIN`                                            | `https://event-q-web.vercel.app`                                      |
| `API_PUBLIC_URL`                                        | `https://<service>.onrender.com`                                      |
| `CORS_ALLOWED_ORIGINS`                                  | `https://event-q-web.vercel.app`                                      |
| `COOKIE_SECURE`                                         | `true`                                                                |
| `JWT_ACCESS_SECRET`                                     | output of `openssl rand -base64 48`                                   |
| `ATTENDEE_TOKEN_SECRET`                                 | a _different_ `openssl rand -base64 48`                               |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `unused`                                                              |
| `AI_ENABLED`                                            | `false`                                                               |
| `API_PROXY_SHARED_SECRET`                               | a third `openssl rand -base64 48` — the same value as on Vercel       |

### 4. Vercel

Project → Settings → Environment Variables (Production):

| Key                       | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| `API_PROXY_TARGET`        | `https://<service>.onrender.com`                           |
| `NEXT_PUBLIC_API_URL`     | `https://event-q-web.vercel.app` — the site's _own_ origin |
| `NEXT_PUBLIC_SITE_URL`    | `https://event-q-web.vercel.app`                           |
| `API_PROXY_SHARED_SECRET` | the same value as on Render                                |

Redeploy.

## Check it

```bash
curl https://<service>.onrender.com/health/ready      # {"status":"ready"} — "degraded" means DB or Redis is wrong
curl -i https://event-q-web.vercel.app/health/live    # 200 through the proxy
```

Then sign in at `https://event-q-web.vercel.app/sign-in`. DevTools → Application
→ Cookies should show the access cookie on `event-q-web.vercel.app`.

## Known limitations

- Render free sleeps after 15 idle minutes; the first request takes 30–60 s and
  the Vercel proxy may give up on that one. Reload once.
- Rate limits need `API_PROXY_SHARED_SECRET` set identically on both sides.
  Without it, every visitor reaches Render from Vercel's address and shares ONE
  per-IP bucket, so ten bad logins from anyone lock out everyone. The web proxy
  (`apps/web/src/proxy.ts`) forwards the real client IP with the secret, and the
  API believes it only when the secret matches. Check after deploying: eleven
  bad logins from your phone's mobile data must not stop you signing in from
  your laptop.
- Supabase pauses idle free projects; Render's free Key Value is not persistent.
  Both are acceptable for a demo and unacceptable for production.
- The free Supabase plan has no backups. A nightly encrypted backup with a
  restore test runs from GitHub Actions; set it up and restore from it with
  [backup-restore.md](backup-restore.md).
