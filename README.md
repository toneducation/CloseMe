# CloseMe

A Telegram-first relationship discovery / **tanishuv** platform for meaningful communication, serious relationships, long-term relationships and friendship-first connections. The website is a **private staff dashboard**, not the member product.

## Release status

This repository extends the existing identity foundation; migration `0001_identity.sql` is preserved. The bot, private admin app, migrations, tests and deployment configurations are implemented. **Not launched:** hosted migrations, real Google credentials, Cloudflare Access/MFA enrollment and live Telegram delivery must be configured and smoke-tested before inviting users. Automated tests cannot certify a live deployment that has not been connected. This is a recovery checkpoint; phase acceptance and browser visual verification are still pending. See `IMPLEMENTATION_PLAN.md`.

The owner can configure the services from Safari on an iPhone. Never send passwords, tokens, service-account JSON or secret keys to a chat or put them in GitHub files.

## What is included

- EN / UZ / RU onboarding: language, adult declaration, DOB, own Telegram contact, HMAC-only phone fingerprint and independent CloseMe username.
- Profiles, five–ten configurable interests, relationship intent, one–six private approved photos; add, replace, delete and choose primary.
- Google Vision SafeSearch adapter; adult/racy/violence `LIKELY` or `VERY_LIKELY` rejected. Unknown, malformed, failed or timed-out checks fail closed. No normal manual approval queue.
- Atomic monthly photo reservations, default 950; no retry/overflow provider. Rejected bytes are never written to Storage. Old approved photos survive rejected replacements.
- Discovery, username search, opt-in approximate nearby search, age/radius/preferences, likes/super likes/passes, idempotent matches, message requests and private text relay.
- Blocks enforced in SQL; reports, review flags, private notification outbox, standard username transfers with both confirmations, expiry and cooldown.
- Separate admin Worker: Cloudflare Access JWT validation, Supabase Auth + TOTP AAL2, active staff lookup and server-side permissions.
- Responsive dashboard, people/profile management, all 36 premium handles, inspector/history, transfer list, reported photos/cases, staff, immutable audit log and emergency switches.

## Architecture

| Path                           | Purpose                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `apps/bot`                     | Public Hono/grammY Telegram webhook Worker; never behind Access          |
| `apps/admin`                   | React/Vite/Tailwind static assets and separate private Hono Worker       |
| `packages/shared`              | Zod, identity helpers, translations and Google safety adapter            |
| `packages/database/migrations` | Ordered additive PostgreSQL/Supabase migrations                          |
| `tests`                        | Identity, SQL transactions, provider and admin security regression tests |

Only trusted Workers possess the Supabase server key. Tables have RLS and no browser grants. Browser code receives only the project URL and publishable key for Auth. Profile photos live in a private bucket and are fetched by authorized Workers; rejected photos have no public URLs.

The service is not end-to-end encrypted: bot relay hides Telegram identity from other members, while approved safety-case review remains possible. Staff cannot list all message content. Every case-bound review requires a reason and is audited. Members can voluntarily type identifying information into messages; CloseMe never attaches their Telegram profile or phone automatically.

## 1. Supabase: preserve the existing database

Since your Supabase project is ready:

1. Open [Supabase Dashboard](https://supabase.com/dashboard), then your CloseMe project.
2. Make a backup/export before applying migrations to a project with real data. Keep exports outside GitHub and chat.
3. Open **SQL Editor → New query**.
4. On GitHub, open `packages/database/migrations/0001_identity.sql`. If the identity foundation was already applied, **do not run it again**. Existing `users`, `usernames` and `admin_users` tables identify that foundation; check your migration records if uncertain. Do not drop these tables.
5. For a fresh project only, run `0001_identity.sql` once.
6. Run `0002_relationships.sql`, then `0003_administration.sql`, then `0004_storage.sql`, each once, in that order. Each file uses a transaction. If a file reports an error, stop and retain the error message without secrets; do not continue or reset the database.
7. In **Storage**, confirm `profile-photos` exists and is **private**. Do not add public policies. It permits JPEGs up to 5 MB.
8. In **Authentication → Providers / Email**, disable public signup. Enable email/password for deliberately created staff only. Disable anonymous signup.
9. In Auth settings, enable TOTP MFA, choose a short JWT lifetime suitable for staff, and keep Auth rate limits enabled. No SMS provider is needed.

SQL migrations are tested against PostgreSQL locally (PGlite) and PostgreSQL 17 in CI. The Storage migration needs Supabase's `storage` schema; verify it on your project before launch. Do not point `TEST_DATABASE_URL` at production: integration tests create test roles and tables.

## 2. Google automatic photo safety — required external setup

Official references checked for this implementation:

- [SafeSearch Detection](https://docs.cloud.google.com/vision/docs/detecting-safe-search)
- [Vision authentication](https://docs.cloud.google.com/vision/docs/authentication)
- [Service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)
- [Vision pricing](https://cloud.google.com/vision/pricing)

In Safari:

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select **Create project**, name it `CloseMe`, then select that project.
3. Open **APIs & Services → Library**, search **Cloud Vision API**, then **Enable**.
4. Google requires a billing-enabled project. Review Google's displayed terms/pricing before enabling billing. If you do not want to enable billing, stop here: new photos remain unavailable; no paid fallback is used.
5. Open **IAM & Admin → Service Accounts → Create service account**, name it `closeme-photo-safety`. Give it the permissions required to consume the enabled Vision API in this project (including Service Usage Consumer for the quota project), not project Owner/Editor. Do not enable domain-wide delegation.
6. Open the account → **Keys → Add key → Create new key → JSON**. Keep the downloaded JSON in a secure location. If your organization disallows account keys, arrange an approved credential mechanism; do not weaken that policy.
7. Paste the entire JSON as the bot Worker's **encrypted secret** `GOOGLE_SERVICE_ACCOUNT_JSON`. Never put this file in the repository or send it in chat. Delete insecure local/download copies after safe storage.
8. Open **APIs & Services → Cloud Vision API → Quotas & System Limits** and lower applicable request quotas for this single-purpose project. Configure billing alerts and review usage. Budgets/alerts are **not hard spending limits**. Verify the controls available on your Google account.
9. Set bot variable `PHOTO_MODERATION_MONTHLY_LIMIT` to `950` (or a lower value). The database atomically reserves each unit before the API is called and refuses replay. Reservations are conservative and are not refunded after failures.

Only one `SAFE_SEARCH_DETECTION` feature is requested per image at `https://vision.googleapis.com/v1/images:annotate`. Credentials use a short-lived RS256 service-account assertion exchanged at Google's OAuth token endpoint. No API key, remote user-supplied image URL or additional paid feature is used.

**The 950 cap protects this application, not your entire Google account.** Other applications/project usage, changed provider terms or misconfiguration can still create costs. Recheck current free allowances in your accounts. The code refuses configured limits above 950 and never silently upgrades. SafeSearch detects content categories; it does not prove age, identity, image sharpness or that a picture is genuine. Report controls remain essential.

## 3. Create separate Cloudflare Workers

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Choose **Create application → Connect to Git** and select `toneducation/CloseMe`.
3. Create the **bot** project named `closeme-bot`. Repository root directory: `/`. Build command: `npm ci`. Deploy command: `npx wrangler deploy --config apps/bot/wrangler.toml`.
4. Create a second project **closeme-admin**, same repository/root. Build: `npm ci && npx vite build apps/admin --config apps/admin/vite.config.ts`. Deploy: `npx wrangler deploy --config apps/admin/wrangler.toml`.
5. Keep the free Workers plan. Do not enable paid overflow. If your dashboard labels differ, the equivalent commands above are the source of truth.
6. Record both workers.dev URLs. Set the admin variables/secrets below before using it. The admin Worker fails closed until Access is configured.
7. The bot's scheduled trigger processes a small notification batch every minute. Confirm the trigger is enabled after deployment.

`npm run build` only creates assets and performs two Wrangler dry-runs. It does not publish. GitHub validation workflows never contain production secrets and do not deploy automatically.

## 4. Configure variables — do not send values in chat

Open the relevant Worker → **Settings → Variables and Secrets → Add**. Mark every credential as **Secret**, not plain text. Save and deploy the updated version.

| Variable                         | Where to obtain it                                                       | Where to paste it                      |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `SUPABASE_URL`                   | Supabase project Connect/API settings                                    | Both Workers, variable                 |
| `SUPABASE_SECRET_KEY`            | Supabase Settings → API Keys, server secret key                          | Both Workers, encrypted secret         |
| `SUPABASE_PUBLISHABLE_KEY`       | Supabase Settings → API Keys, publishable key                            | Admin Worker, variable                 |
| `GOOGLE_SERVICE_ACCOUNT_JSON`    | Google service-account JSON from step 2                                  | Bot Worker, encrypted secret           |
| `PHOTO_MODERATION_MONTHLY_LIMIT` | Set to 950 or less                                                       | Bot Worker, variable                   |
| `PHONE_HMAC_SECRET`              | Password manager: generate at least 32 random characters                 | Bot Worker, encrypted secret           |
| `TELEGRAM_BOT_TOKEN`             | Official @BotFather; rotate old shared token before migration            | Bot Worker, encrypted secret           |
| `TELEGRAM_WEBHOOK_SECRET`        | Password manager: 32–256 random letters/digits/underscores/hyphens       | Bot Worker, encrypted secret           |
| `TELEGRAM_BOT_ID`                | Numeric prefix of bot token, or setup script getMe output                | Bot Worker, variable                   |
| `TELEGRAM_BOT_USERNAME`          | @BotFather bot username, without @                                       | Bot Worker, variable                   |
| `ACCESS_TEAM_DOMAIN`             | Cloudflare Zero Trust team domain, e.g. `your-team.cloudflareaccess.com` | Admin Worker, variable, no scheme/path |
| `ACCESS_AUD`                     | Admin Access application's Application Audience (AUD) tag                | Admin Worker, variable                 |
| `ADMIN_ORIGIN`                   | Admin Worker's HTTPS origin, no trailing slash                           | Admin Worker, variable                 |

Never use a `VITE_*` variable for the server key. A Telegram admin chat ID is **not** staff authorization and is not needed for this web administration architecture. Owner privileges come from verified Supabase Auth + TOTP + the `admin_users` record.

Do not casually rotate `PHONE_HMAC_SECRET` after members register: it is needed for stable uniqueness fingerprints. Recovery/rotation requires a deliberate verification migration because raw phone numbers are not retained.

## 5. Protect only the admin Worker with Cloudflare Access

1. In Cloudflare, open **Zero Trust / Cloudflare One** and create your team if necessary. Review the free plan seat limit shown in your account.
2. For `closeme-admin`, open its **Settings → Domains & Routes / workers.dev** and enable Access protection for that hostname. Cloudflare supports workers.dev protection without buying a custom domain.
3. Open the created Access application. Allow only your exact owner email and deliberately approved staff emails. Do not use an “Everyone” allow/bypass policy.
4. Copy the team domain and application's AUD into the admin Worker variables above.
5. Protect the entire admin hostname, including `/api/*`. Preview URLs are disabled in its Wrangler configuration. Any later custom/preview hostname must get equivalent protection.
6. Test in a private Safari tab: unauthenticated visitors must encounter Access or receive 403. `/api/metrics` without a verified AAL2 staff session must not return data.
7. **Do not attach Access to `closeme-bot` or `/telegram/webhook`.** Telegram must reach that endpoint with its own webhook secret.

Reference: [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). The Worker validates signature, issuer and audience itself; trusting a header's presence alone is insufficient.

## 6. Create the first OWNER and enroll TOTP

1. Supabase → **Authentication → Users → Add user → Create user**. Create your own staff account deliberately, using your email and a strong unique password. Do not enable public signup. Record its **Auth user UUID** (not Telegram ID).
2. SQL Editor: replace the placeholders below with that UUID and your email, then run once. No password or API key belongs in this query.

```sql
insert into public.admin_users(id, role, active, email)
values ('YOUR_AUTH_USER_UUID', 'OWNER', true, 'YOUR_OWNER_EMAIL');
```

3. In Supabase **Authentication → URL Configuration**, set the admin HTTPS origin as Site URL and an allowed redirect URL. Invitations must return to this protected origin.
4. Open the admin hostname, pass Cloudflare Access, then sign in with the staff email/password.
5. Enroll an authenticator. On one iPhone, copy the displayed setup key into a TOTP authenticator's manual setup, then return and enter its six-digit code. Alternatively scan the QR with a second device. Keep the setup key private.
6. The dashboard becomes available only after AAL2 verification. AAL1/password-only access is denied by every privileged API.
7. In **Staff**, OWNER can deliberately invite colleagues, select their roles and give a reason. Also add their exact email to Access. They must enroll TOTP. Configure Supabase email delivery as needed; its default email service has recipient/rate restrictions. If delivery is unavailable, deliberately create the Auth user in the dashboard and add the staff UUID using the owner-controlled procedure; do not enable signup.
8. The single OWNER cannot be disabled, deleted or downgraded through normal UI/SQL operations. Keep secure recovery access to the Supabase and Cloudflare owner accounts. Losing the authenticator requires a documented identity-verified break-glass process in Supabase, followed by re-enrollment and review of audit/session history.

SUPPORT can inspect and warn; MODERATOR can handle reports/suspensions; OWNER/SUPER_ADMIN alone control premium ownership and bans; OWNER alone manages staff and emergency settings. Sensitive mutations require a reason and execute with a matching database permission check.

## 7. Telegram migration from the old backend — do this last

Do not switch production Telegram traffic until migrations, safety credentials, Access and OWNER login have passed private tests.

1. Open the **official verified @BotFather** in Telegram. Select the CloseMe bot through `/mybots`. If its old token was ever given to Lovable or another untrusted system, use token revoke/regeneration (`/revoke` or the API Token controls).
2. Put the new token only in the new bot Worker's encrypted `TELEGRAM_BOT_TOKEN` secret. Rotating a token intentionally stops the old backend; schedule the cutover and have the new Worker ready.
3. Remove the old bot credential from Lovable integrations and disable old bot jobs/webhook code. Do not copy old architecture or secrets into this repository.
4. Set the new `TELEGRAM_WEBHOOK_SECRET`, bot ID and username in Cloudflare.
5. Configure the new webhook using `scripts/telegram-setup.mjs` from a trusted environment with environment variables `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `WORKER_URL`. The script uses POST, requests messages/callback queries, sets one connection and verifies `getWebhookInfo` without printing the token.
6. **Phone-only:** use the manual GitHub workflow described below; add its token and webhook secret only as encrypted GitHub Actions secrets, run once, then delete those temporary Actions secrets. Do not put the token in Safari's address bar or a GitHub file.
7. Send `/start` privately. Confirm language, 18+, DOB, own contact and username setup; reject another person's shared contact.
8. Verify webhook info identifies only the new Worker, check pending updates, and confirm the old backend no longer receives traffic. A Telegram bot has one configured webhook; token rotation invalidates the old credential.
9. If Lovable held a Supabase server key, create a new server secret in Supabase API Keys, update both Workers, verify their health, then revoke the old key. For legacy `service_role` JWT keys use Supabase's supported legacy JWT-key rotation procedure; account for effects on existing sessions and other integrations. Never revoke first without a tested replacement.

### Phone-only webhook configuration

GitHub repository → **Settings → Secrets and variables → Actions**:

- `TELEGRAM_BOT_TOKEN`: obtain from @BotFather; paste as temporary encrypted Actions secret.
- `TELEGRAM_WEBHOOK_SECRET`: same value already stored in Cloudflare; paste as temporary encrypted Actions secret.

Then **Actions → Configure Telegram webhook → Run workflow**. Enter only the public bot Worker URL. Read its success output and remove the two temporary Actions secrets afterward. The workflow does not use pull requests or untrusted code. Run only from your reviewed main branch.

## 8. Private launch checks

Use two consenting adult test accounts, a third blocked account and a test staff account before public launch:

- Complete all three language flows, verify own contact, reject under-18 dates, reserve/case/premium username rules.
- Upload a normal photo. Verify only approved photos appear; simulate provider failure in a test environment and confirm old photos remain after failed replacement. Do not intentionally upload illegal content.
- Lower the moderation cap in a test environment to exhaust it; verify the next upload produces no Google request and retains the existing profile. Check Google usage separately.
- Exercise profiles, search, nearby opt-in and location deletion, likes/mutual match, request accept/decline, message relay, report and block. Verify that blocked relationships disappear and newly attempted messages fail.
- Transfer a standard username with both confirmations; verify expiration/replay behavior. Test premium gifting as OWNER and denial as SUPPORT.
- Test admin Access denial, password-only denial, TOTP acceptance, disabled staff denial, confirmation/reason dialogs, audit immutability and case-bound conversation review.
- Check the admin dashboard at iPhone width. Ensure no server key, phone number, exact coordinates or Telegram profile link appears in member responses/browser bundles.
- Test every emergency switch and restore it. Confirm bot webhook remains public to Telegram while admin remains private.
- Watch safe operational logs/queues and quota usage before widening access. Do not invite users while any gate fails.

## Operations, limits and recovery

- **Emergency controls:** OWNER → Emergency controls can pause registrations, photos, first-message requests, messages or transfers independently. Pausing registration still permits existing accounts. Changes preserve data and are audited.
- **Notifications:** a bounded leased outbox retries up to five times. Telegram has no idempotency key for sendMessage: a crash after delivery but before acknowledgement may produce a duplicate notification. Database likes, matches, transfers and message writes remain idempotent. Block transactions cancel queued notifications; an HTTP request already handed to Telegram cannot be recalled.
- **Privacy:** location is rounded to a 0.05° cell; displayed distance is coarsened to 5 km. Opting out clears the stored cell. Disabling notifications mutes optional social alerts; retain responsibility to review service messages.
- **Performance:** social write transactions use a shared advisory lock to make block/send/match races safe. This is a deliberate small-launch tradeoff. Measure before scaling and partition locks only with concurrency tests. Admin searches return pages of 50; Telegram inboxes show the latest 20.
- **Quotas:** photo cap defaults to 950 per UTC month and only supports lower overrides. First requests default to five per day (OWNER can set 1–20); likes 100/day, super likes 3/day, messages 30/min, photos 10/hour, reports 5/hour. Workers/Supabase free limits may stop service; no code silently upgrades them.
- **Storage:** only approved images are persisted. Failed replacements never overwrite the old image. Deleted/replaced object cleanup currently retries on subsequent uploads; a dedicated cleanup job remains a production follow-up. Database status prevents these objects being served. Monitor private bucket usage.
- **Backups:** export PostgreSQL and separately back up private Storage using authorized tooling. Encrypt exports, restrict access, document retention and rehearse restore into an isolated project. Database backup alone does not restore image objects. Do not assume a free plan includes managed point-in-time recovery.
- **Audit/history:** retain immutable ownership/admin history. No frontend mutation endpoint edits it. Service/database owner access is a high-trust operational boundary; SQL triggers are not protection against a database superuser deliberately disabling them.
- **Before production:** define support contact, privacy/retention policy, abuse response and account-deletion procedure appropriate to your launch. DOB/contact attestation and SafeSearch are not identity verification guarantees.

## Developer verification

Node.js 22+:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
```

CI runs these against PostgreSQL 17. Local tests default to disposable PGlite. To exercise actual concurrent connections locally, set `TEST_DATABASE_URL` to a new disposable PostgreSQL database, never a real project. Local bot secrets may be stored in `apps/bot/.dev.vars`; admin secrets in `apps/admin/.dev.vars`. Both are ignored. Do not bypass Access in deployed code for development.
