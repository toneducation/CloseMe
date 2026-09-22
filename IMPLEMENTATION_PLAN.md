# CloseMe implementation plan

Telegram-first relationship discovery. Private React admin dashboard. No Lovable dependencies.

1. TypeScript monorepo: Hono/grammY Worker, React/Vite admin, shared Zod types, Supabase migrations.
2. Atomic username registration, admin-controlled single-character handles, confirmed expiring transfers and immutable history.
3. Adult onboarding, own-contact verification with phone HMAC, profiles, private photos and manual moderation fallback.
4. Discovery, approximate nearby search, likes/matches, rate-limited message requests, private bot relay, blocks and reports.
5. Server-verified staff authentication and roles, premium username center, moderation queues, audit log and metrics.
6. Critical security and transaction tests, typecheck, lint, build, CI and phone-friendly deployment guide.

No unreviewed photos enter discovery. No raw phone or exact location exposed. Secrets stay outside Git. External project creation and secret configuration are deployment gates; do not request secrets in chat.

## Progress checkpoint

- Completed: identity foundation, three-language /start, adult/date/contact gates, canonical username claim, reserved/premium rules, transfer and premium gift database primitives, HMAC privacy, RLS, rate limits and immutable identity history.
- Validated locally: strict TypeScript, ESLint, 29 unit/migration tests and Worker dry-run bundle. Hosted Supabase and real Telegram smoke tests remain pending.
- Added CI using actual PostgreSQL for concurrent claim and transfer integration tests.
- Next external setup gate: create a Supabase project. Never send its database password or API secrets in chat.
- Remaining implementation: full dating profiles/photos/discovery/social/messaging, admin authentication/API/UI, moderation workflows and launch hardening. This checkpoint is not a production launch.
