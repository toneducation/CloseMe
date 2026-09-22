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
- Remaining implementation: full relationship discovery profiles/photos/discovery/social/messaging, admin authentication/API/UI, moderation workflows and launch hardening. This checkpoint is not a production launch.

## Relationship release continuation

Preserve migration 0001 and identity contracts. Add migrations rather than resetting the database.

1. Add relationship profile/social/photo/admin data and atomic operations, with backend-only grants.
2. Automatic Google SafeSearch through service-account OAuth and a fail-closed, atomic monthly reservation cap; store only approved bytes.
3. Complete Telegram profile/navigation/discovery/conversation/transfer flows with centralized translations.
4. Separate admin Worker and static assets: verified Cloudflare Access JWT, Supabase Auth + AAL2, live staff role checks, case-bound conversation review.
5. Regression/concurrency/provider/API tests, builds, CI; document remaining external credentials and live smoke-test gates honestly.

V1 uses database transaction serialization for social operations to make blocking, matching and messaging consistent. Scale beyond free-tier use requires measuring and partitioning locks. SafeSearch is a content classifier, not proof of identity or age.

## Recovery checkpoint — 2026-09-22

Preserved the existing identity migration and all valid uncommitted work. This checkpoint contains interdependent implementation from the interrupted broad task; it is not a declaration that all production phases are complete.

- Implemented locally: additive relationship/social/admin migrations, centralized EN/UZ/RU flows, private approved-photo storage flow, automatic Google SafeSearch with atomic cap, Telegram discovery/messages/transfers, separate authenticated admin Worker and responsive UI.
- Recovery fix: the new admin-hidden/self-pause regression test passed a fixture object where a user UUID was required; corrected it to use the fixture ID.
- Hosted migrations, real Google checks, actual Access/TOTP login and Telegram smoke tests remain unverified.
- Browser visual verification could not run: browser installation failed in this environment. No visual-test success is claimed.
- Known follow-ups: photo-object cleanup currently runs after uploads rather than a dedicated cleanup job; strengthen end-to-end handler/UI tests and notification operations before launch. Review each implemented phase against its acceptance criteria rather than treating a successful build as production certification.

From this checkpoint onward use the owner's requested order, with a separate validated commit and push after each phase:

1. Relationship profile + interests + database acceptance.
2. Photo upload/change + Google SafeSearch + quota acceptance.
3. Find People + username search + Nearby acceptance.
4. Like + Skip + Super Like + Match acceptance.
5. Message requests + private relay acceptance.
6. Block + Report + anti-abuse acceptance.
7. Standard username transfer Telegram UX acceptance.
8. Private admin + authentication + TOTP + RBAC acceptance.
9. Premium username admin center acceptance.
10. Security hardening + full tests + deployment documentation.

Every phase: implement → typecheck → lint → test → format check → build → fix → commit → push. No live launch until external configuration and private smoke tests pass.
