# API, Config and Rate-Limit Reference

Derived from `server.js`, `src/routes/*.js`, `src/middleware/rateLimiter.js` and
`.env.example`. The `globalLimiter` is applied app-wide in `server.js` before the
routers (line ~74), so it applies to every route below in addition to any
route-specific limiter.

## a) Routes

| Method | Path | Auth required | Rate limiter(s) | Purpose |
|---|---|---|---|---|
| GET | `/api/listings` | None (public) | globalLimiter | List approved, active listings (paginated; contact stripped) |
| GET | `/api/listings/:id` | None; `X-Owner-Token`/admin for contact | globalLimiter | Single listing detail (contact only for owner/admin) |
| PUT | `/api/listings/:id` | `X-Owner-Token` or admin | globalLimiter + paymentLimiter | Update a listing (content re-screened) |
| DELETE | `/api/listings/:id` | `X-Owner-Token` or admin | globalLimiter + paymentLimiter | Delete a listing |
| PUT | `/api/listings/:id/moderate` | Admin (`X-Admin-Key` or `X-Admin-Session`) | globalLimiter | Moderate a listing (approved/flagged/removed) |
| POST | `/api/upload` | None (public) | globalLimiter + uploadLimiter | Validate and store an image |
| POST | `/api/payments/boost` | `X-Owner-Token` (checked in controller) | globalLimiter + paymentLimiter | Initiate a boost STK push |
| POST | `/api/payments/initiate-listing` | None (public) | globalLimiter + paymentLimiter + listingCreateLimiter (+ honeypot) | Initiate a listing payment |
| POST | `/api/payments/initiate-store-plan` | None (public) | globalLimiter + paymentLimiter + listingCreateLimiter (+ honeypot) | Initiate a store-plan payment |
| POST | `/api/payments/webhook` | IntaSend (shared `challenge` secret) | globalLimiter | Payment state webhook (intentionally not rate-limited further) |
| GET | `/api/payments/status/:invoiceId` | None (public) | globalLimiter + statusLimiter | Poll payment status |
| POST | `/api/admin/setup-2fa` | `X-Admin-Key` | globalLimiter + adminLimiter | Generate a TOTP secret + QR |
| POST | `/api/admin/verify-2fa` | `X-Admin-Key` + TOTP code | globalLimiter + adminLimiter | Enable 2FA |
| POST | `/api/admin/login` | `X-Admin-Key` + TOTP code | globalLimiter + adminLimiter | Issue a session token |
| POST | `/api/admin/payments/:paymentReference/replay` | `X-Admin-Session` | globalLimiter + adminLimiter | Replay a payment that never completed |
| PUT | `/api/admin/stores/:id/moderate` | Admin auth | globalLimiter + adminLimiter | Moderate a store (approved/flagged/removed) |
| PUT | `/api/admin/stores/:id/suspend` | Admin auth | globalLimiter + adminLimiter | Suspend a store |
| GET | `/api/admin/audit-logs` | `X-Admin-Session` | globalLimiter + adminLimiter | Read audit logs |
| GET | `/api/admin/payments` | `X-Admin-Session` | globalLimiter + adminLimiter | List payments |
| POST | `/api/admin/blocks` | `X-Admin-Session` | globalLimiter + adminLimiter | Block the contacts behind a listing, store or number |
| GET | `/api/admin/blocks` | `X-Admin-Session` | globalLimiter + adminLimiter | List blocked contacts (hash/number never returned) |
| DELETE | `/api/admin/blocks/:id` | `X-Admin-Session` | globalLimiter + adminLimiter | Remove a blocked contact |
| GET | `/api/admin/reports` | `X-Admin-Session` | globalLimiter + adminLimiter | List reports (open by default; reporter IP never returned) |
| PUT | `/api/admin/reports/:id/resolve` | `X-Admin-Session` | globalLimiter + adminLimiter | Resolve an open report (records the action; does not moderate) |
| GET | `/api/admin/health` | `X-Admin-Session` | globalLimiter + adminLimiter | Detailed health (MongoDB + Cloudinary with a 5s timeout); always HTTP 200 |
| GET | `/api/stores/slug/:slug` | None; `X-Store-Owner-Token`/admin for contact | globalLimiter | Public store by slug (flagged/removed hidden) |
| GET | `/api/stores/me/all` | `X-Store-Owner-Token` | globalLimiter | All stores owned by the presented token |
| GET | `/api/stores/:id` | `X-Store-Owner-Token` | globalLimiter | Owner's store by id (full data) |
| PUT | `/api/stores/:id` | `X-Store-Owner-Token` (store must be active) | globalLimiter | Update a store (content re-screened) |
| DELETE | `/api/stores/:id` | `X-Store-Owner-Token` or admin | globalLimiter | Delete a store and its listings |
| PUT | `/api/stores/:id/attach-listing` | `X-Store-Owner-Token` (active) + `X-Owner-Token` | globalLimiter | Attach a listing to a store |
| PUT | `/api/stores/:id/detach-listing` | `X-Store-Owner-Token` (active) + `X-Owner-Token` | globalLimiter | Detach a listing from a store |
| GET | `/api/terms/versions` | None (public) | globalLimiter | Current terms versions |
| POST | `/api/terms/contact-acceptance` | None (public; acceptance token required) | globalLimiter + contactLimiter + contactReleaseLimiter | Record buyer acceptance and release seller contact |
| POST | `/api/reports` | None (public) | globalLimiter + reportLimiter (+ honeypot) | Submit a user report against a listing or store |
| GET | `/health` | None (public) | globalLimiter | Public health: 200 `{ status: 'healthy' }` / 503 `{ status: 'unhealthy' }`, MongoDB only |

## b) Environment variables

| Name | Purpose | Default | Required in production | Min length |
|---|---|---|---|---|
| `NODE_ENV` | Runtime mode (development/production/test) | development | No | — |
| `PORT` | HTTP listen port | 5000 | No | — |
| `TRUST_PROXY` | Number of proxy hops to trust | 1 | No | — |
| `APP_URL` | Public base URL (IntaSend callback host) | — | No (not enforced by the startup guard) | — |
| `MONGO_URI` | MongoDB connection string | — | Yes (fatal when missing/blank, except test) | — |
| `ADMIN_KEY` | Bootstrap admin key (`X-Admin-Key`) | changeme (placeholder) | Yes | 16 |
| `ADMIN_SESSION_SECRET` | HMAC secret for admin session tokens | changeme (placeholder) | Yes | 16 |
| `INTASEND_PUBLISHABLE_KEY` | IntaSend publishable key | ISPubKey_test_changeme | No | — |
| `INTASEND_SECRET_KEY` | IntaSend secret key | ISSecretKey_test_changeme | No | — |
| `INTASEND_TEST_MODE` | `true` routes IntaSend to sandbox | true | No | — |
| `INTASEND_WEBHOOK_CHALLENGE` | Shared secret the webhook must echo | changeme (placeholder) | Yes | 16 |
| `BLOCK_HASH_SECRET` | HMAC key for hashing blocked contact numbers | dev/test fallback constant (not used in production) | Yes | 16 |
| `STATUS_RATE_LIMIT` | Payment-status polls per minute per IP | 60 | No | — |
| `CONTACT_RELEASE_LIMIT` | Contact releases per hour per IP | 40 | No | — |
| `REPORT_RATE_LIMIT` | Public report submissions per hour per IP | 10 | No | — |
| `AUDIT_RETENTION_DAYS` | Days to keep audit events before pruning | 365 | No | — |
| `WHAPI_TOKEN` | Whapi.Cloud bearer token for broadcasts | changeme | No | — |
| `WHATSAPP_GROUPS` | Comma-separated broadcast group IDs | — | No | — |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account name | changeme | No | — |
| `CLOUDINARY_API_KEY` | Cloudinary API key | changeme | No | — |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | changeme | No | — |
| `CORS_ORIGINS` | Comma-separated allowed origins | `https://gikomart.onrender.com,http://localhost:5000` | No | — |

## c) Rate limiters

| Name | Window | Max | Env override |
|---|---|---|---|
| `globalLimiter` | 60 s | 100 | — |
| `uploadLimiter` | 60 s | 10 | — |
| `paymentLimiter` | 60 s | 5 | — |
| `listingCreateLimiter` | 60 s | 5 | — |
| `contactLimiter` | 60 s | 20 | — |
| `adminLimiter` | 60 s | 10 | — |
| `statusLimiter` | 60 s | 60 | `STATUS_RATE_LIMIT` |
| `contactReleaseLimiter` | 3600 s (1 hour) | 40 | `CONTACT_RELEASE_LIMIT` |
| `reportLimiter` | 3600 s (1 hour) | 10 | `REPORT_RATE_LIMIT` |

The env-tunable limiters use `Number.parseInt` and fall back to their default
when the value is missing or not a positive integer.

## d) Deployment warnings

From `src/config/envGuard.js` and `server.js`:

- **Insecure production secrets refuse startup.** With `NODE_ENV=production`,
  `assertProductionSecrets()` runs at module load and exits if `ADMIN_KEY`,
  `ADMIN_SESSION_SECRET`, or `INTASEND_WEBHOOK_CHALLENGE` is missing, a known
  placeholder (`changeme`/`undefined`/`''`), or shorter than 16 characters.
- **Missing database refuses startup.** `assertStartupConfig()` exits when
  `MONGO_URI` is missing or blank in any environment except `test`. It runs only
  when `server.js` is the entry module (`require.main === module`), i.e. the
  normal `node server.js` path.
- **Missing or short block-hash secret refuses startup.** In production,
  `assertStartupConfig()` also reports `BLOCK_HASH_SECRET` when it is missing,
  blank, or shorter than 16 characters; development and test use a fixed fallback
  (see `src/utils/phone.js`).
- **Trust proxy defaults to 1.** `TRUST_PROXY` must be increased to `2` when
  Cloudflare proxies in front of Render so `req.ip` stays the real client address.

## e) Audit event actions

Every action string emitted by `emit()` in `src/`, with the `resource` it is
written under (read from the source, not guessed). Events carry field names and
ids only — never values, contact data, hashes or reporter IPs.

| Action | Resource |
|---|---|
| `admin.audit_logs_viewed` | admin |
| `admin.payments_viewed` | admin |
| `admin.lockout_triggered` | admin |
| `admin.session_invalid` | admin |
| `admin.block_added` | block |
| `admin.block_removed` | block |
| `admin.report_resolved` | report |
| `listing.update` | listing |
| `listing.auto_flagged` | listing |
| `listing.delete` | listing |
| `listing.moderate` | listing |
| `store.update` | store |
| `store.auto_flagged` | store |
| `store.delete` | store |
| `store.attach_listing` | store |
| `store.detach_listing` | store |
| `store.moderate` | store |
| `store.suspended` | store |
| `payment.blocked_contact` | payment |
| `payment.completed` | payment |
| `payment.amount_mismatch` | payment, Payment |
| `webhook.missing_invoice_id` | payment |
| `webhook.broadcast_skipped` | listing |

## f) Data retention

Every stripping job in `src/services/cleanupService.js` (run by the 30-minute
scheduler), with its window and the fields it clears. Records are never deleted
by these jobs — only the named fields are cleared.

| Job | Window | Fields cleared |
|---|---|---|
| `stripExpiredStoreContacts` | 30 days after `expires_at` | `Store.phone`, `whatsapp`, `email`, `location`, `pickup_location` |
| `stripOldAcceptancePII` | 30 days after `timestamp` | `TermsAcceptance.actor.ip`, `actor.phoneHash`, `actor.userAgent` |
| `stripOldReportPII` | 30 days after `createdAt` | `Report.reporterIp` |
| `stripOldPaymentPII` | 90 days after `createdAt` (completed/failed only) | `Payment.phoneNumber` (set to `redacted`) and unsets `listingData.sellerWhatsapp`, `storeData.phone`, `storeData.whatsapp`, `storeData.email` |
| `stripOldAcceptanceHashes` | 30 days after `timestamp` | `TermsAcceptance.actor.whatsappHash`, `sellerContactTarget.sellerWhatsappHash` |
| `pruneOldAuditEvents` | `AUDIT_RETENTION_DAYS` days after `timestamp` (default 365) | deletes the audit event (via `deleteMany`) |
