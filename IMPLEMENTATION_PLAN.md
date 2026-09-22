# CloseMe implementation plan

Telegram-first relationship discovery. Private React admin dashboard. No Lovable dependencies.

1. TypeScript monorepo: Hono/grammY Worker, React/Vite admin, shared Zod types, Supabase migrations.
2. Atomic username registration, admin-controlled single-character handles, confirmed expiring transfers and immutable history.
3. Adult onboarding, own-contact verification with phone HMAC, profiles, private photos and manual moderation fallback.
4. Discovery, approximate nearby search, likes/matches, rate-limited message requests, private bot relay, blocks and reports.
5. Server-verified staff authentication and roles, premium username center, moderation queues, audit log and metrics.
6. Critical security and transaction tests, typecheck, lint, build, CI and phone-friendly deployment guide.

No unreviewed photos enter discovery. No raw phone or exact location exposed. Secrets stay outside Git. External project creation and secret configuration are deployment gates; do not request secrets in chat.
