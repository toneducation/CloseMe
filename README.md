# CloseMe

Telegram-first relationship discovery. This repository is being implemented in phases from a clean TypeScript architecture. There is no Lovable dependency.

**Current state: tested identity foundation, not a launched or complete dating platform.**

Implemented:

- Cloudflare Worker + Hono + grammY private-chat webhook.
- English, Uzbek and Russian onboarding, explicit 18+ confirmation and birth-date validation.
- Own-contact verification (`contact.user_id === from.id`). Only keyed phone HMAC is persisted.
- Canonical case-insensitive usernames, reserved handles and 36 admin-controlled one-character handles.
- PostgreSQL transactional claim, premium gift and two-party transfer functions; expiry, replay checks, cooldown and immutable ownership history/audit.
- Server-only identity tables, RLS, rate-limit RPC, webhook secret checks, completed-update receipts and redacted error logging.
- Unit tests, migration tests, real PostgreSQL concurrency tests in CI and Worker build checks.
- Manual photo moderation provider contract. Its default always returns NEEDS_REVIEW.

**Still to implement:** full profiles and photo storage/review, discovery/nearby/search, likes/matches, messaging and requests, blocking/reporting, risk workflows, notifications/outbox, transfer bot screens, admin authentication/API/dashboard, metrics and deployment automation. The premium gift function is a database primitive, not an admin UI. The bot explicitly tells users that discovery is not open.

## Your next step (phone-friendly)

1. Open https://supabase.com/dashboard in Safari and sign in.
2. Choose **New project** and select your organization (create one if asked).
3. Name the project `CloseMe`. Choose the Free plan if offered, and a region close to your expected users.
4. Create and save a strong database password in your password manager. Do not send it in chat.
5. Wait until the project is ready. At this stage, return to the implementation chat and say **Supabase project ready**. Do not enable public registrations or deploy this partial release as a public service.

The following sections document later steps. Complete them when the corresponding implementation phase is ready.

## Database setup

On a **new project**, open **SQL Editor**, create a query, copy the complete contents of `packages/database/migrations/0001_identity.sql`, and run it. Do not use a production database containing unrelated application tables. The migration is transactional and must be applied once. It enables RLS and revokes browser-role access to the CloseMe objects. All application operations go through the Worker, with a backend-only Supabase secret.

For local verification:

```sh
npm ci
npm run check
npm run build
```

Local migration tests use PGlite (PostgreSQL compiled to WebAssembly). CI runs the same SQL against an isolated PostgreSQL 17 service with separate concurrent client connections. To run with a real database locally, set `TEST_DATABASE_URL` to a **new disposable database**. Never point it at your Supabase project. Tests create tables and test roles.

## Backend secrets (never put these in chat or GitHub code)

| Variable                  | Obtain it from                                           | Paste it into                                                     |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | Telegram's verified `@BotFather`, `/newbot`              | Cloudflare Worker → Settings → Variables and Secrets, type Secret |
| `TELEGRAM_WEBHOOK_SECRET` | Password manager, random 64-character alphanumeric value | Same Worker secrets screen                                        |
| `PHONE_HMAC_SECRET`       | Password manager, a separate random 64-character value   | Same Worker secrets screen                                        |
| `SUPABASE_URL`            | Supabase project Connect/API settings                    | Worker variables                                                  |
| `SUPABASE_SECRET_KEY`     | Supabase project API keys, server-side Secret key        | Worker secrets                                                    |
| `TELEGRAM_BOT_ID`         | `getMe`, via setup script below                          | Worker variables                                                  |
| `TELEGRAM_BOT_USERNAME`   | `@BotFather` bot username, without `@`                   | Worker variables                                                  |

Never put the Supabase secret key in a frontend `VITE_*` variable. Future admin login will use a publishable key and verified staff sessions; publishable keys do not authorize access to these tables.

**Keep `PHONE_HMAC_SECRET` stable and backed up.** Rotating it without a migration changes all phone fingerprints. Contact ownership confirms access to a Telegram phone contact; it does not prove a person's legal identity or age. Birth date and 18+ confirmation are self-declared; underage reports still need human moderation.

## Local private-bot test

1. Copy `.env.example` to `apps/bot/.dev.vars` and fill values locally. Both `.env` and `.dev.vars` are ignored.
2. Run `npm run dev` for a local Worker. Production uses webhooks, not polling.
3. For a private integration environment deploy with `npx wrangler deploy --config apps/bot/wrangler.toml` after setting Cloudflare secrets. No secrets are required to run the dry-run build.
4. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `WORKER_URL` in a trusted terminal environment, then run `node scripts/telegram-setup.mjs`. The script prints only non-secret bot metadata. It configures one webhook connection and preserves pending updates.
5. Send `/start` to the private bot. Check all three languages with test accounts; reject a different person's contact, an underage birth date, a reserved name, a one-character name, and duplicate username claims.

A fully phone-based deployment workflow will be added with the completed product. Do not paste token-bearing Telegram URLs into Safari or chat.

## Important operational limits

- This onboarding release configures Telegram `max_connections=1`; keep that setting until durable per-user processing is implemented. PostgreSQL identity writes are transactional and retry-safe. Telegram replies are at-least-once and can duplicate if a network failure occurs between sending and recording completion.
- No production traffic or public profile photos until the rest of the safety pipeline is implemented and tested.
- Manual review has no paid AI API dependency, but requires moderator time. A generic image classifier is not sufficient evidence that a profile photo is safe. Optional moderation providers must send uncertain results to a human and fail closed.
- Phone HMACs, Telegram IDs and birth dates are private. No browser RLS policy grants direct access.
- The service key is powerful. Restrict who can read Worker secrets and Supabase project settings.
- Rate-limit windows and webhook receipts need scheduled retention cleanup before public launch.
- Free tiers have quotas and may pause or throttle. No promise of unlimited users, permanent free hosting or guaranteed 24/7 uptime.

## Reference documentation

- https://grammy.dev/hosting/cloudflare-workers-nodejs
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#contact
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://developers.cloudflare.com/workers-ai/models/resnet-50/

## Deployment gates

1. Supabase project exists and migration passes against hosted PostgreSQL.
2. All remaining product phases implemented and checked.
3. Staff authentication with MFA, private storage and moderator access tested.
4. Two-account end-to-end tests: mutual likes, blocked messages/search, report-based conversation review, transfers, photo rejection and webhook retries.
5. Secrets configured, private bot smoke test passed, then explicit launch decision.
