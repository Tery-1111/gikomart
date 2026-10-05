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
| GET | `/api/admin/metrics` | `X-Admin-Session` | globalLimiter + adminLimiter | Counts and revenue totals (no personal data) |
| POST | `/api/admin/grant-free-access` | Admin auth (`X-Admin-Key` or `X-Admin-Session`) | globalLimiter + adminLimiter | Complete a pending listing/store payment without a webhook (mock payment) |
| POST | `/api/admin/grant-preview` | Admin auth (`X-Admin-Key` or `X-Admin-Session`) | globalLimiter + adminLimiter | Preview the pending payment a grant would claim (read-only) |
| POST | `/api/grants` | None (public) | globalLimiter + reportLimiter (+ honeypot) | Submit a Free Grant request (admin-reviewed; no payment) |
| GET | `/api/grants/status/:claimId` | Grant claim token (`X-Grant-Token`) | globalLimiter + statusLimiter | Poll a Free Grant request's status |
| POST | `/api/grants/:claimId/redeem` | Grant claim token (`X-Grant-Token`) | globalLimiter + paymentLimiter | Redeem an approved Free Grant through existing provisioning |
| GET | `/api/admin/grants` | `X-Admin-Session` | globalLimiter + adminLimiter | List Free Grant requests (full normalized number, session-gated; masked form also included; never any token/hash) |
| POST | `/api/admin/grants/:id/approve` | `X-Admin-Session` | globalLimiter + adminLimiter | Approve a pending Free Grant request (atomic pending → approved) |
| POST | `/api/admin/grants/:id/reject` | `X-Admin-Session` | globalLimiter + adminLimiter | Reject a pending Free Grant request (atomic pending → rejected) |
| POST | `/api/admin/grants/:id/continuation-token` | `X-Admin-Session` | globalLimiter + adminLimiter | Mint a NEW continuation credential for an approved, unprovisioned grant (rotates `claimTokenHash`; raw token returned once, only here) |
| POST | `/api/admin/grants/:id/qa-flag` | `X-Admin-Session` | globalLimiter + adminLimiter | Toggle the QA/test marker on a grant request (`{ isTest: boolean }`; cosmetic only — lifecycle unchanged; writes `admin.grant_test_flag_set`) |
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
| `GRANT_MINT_ALERT_THRESHOLD` | Continuation-token mints per hour that trigger an `admin.grant_mint_volume_alert` audit event + warn log (advisory only — never blocks) | 5 | No | — |
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
| `grant.requested` | grant |
| `grant.blocked_contact` | grant |
| `grant.redeemed` | Listing, Store |
| `admin.grant_requests_viewed` | admin |
| `admin.grant_approved` | grant |
| `admin.grant_rejected` | grant |
| `admin.grant_continuation_minted` | grant |
| `admin.grant_mint_volume_alert` | grant |

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

## g) Static asset headers

`express.static('public', …)` reads its options from
`src/config/staticOptions.js`. Files under `public/admin/` and the two admin
assets (`public/assets/js/admin.js`, `public/assets/css/admin.css`) are served
with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. Everything
else is unchanged: other assets keep `max-age=604800`, and every other `.html`
file keeps `Cache-Control: public, max-age=0`.

## h) Grant free access (admin mock payment)

`POST /api/admin/grant-free-access` completes a **pending** `listing` or `store`
payment without a real IntaSend webhook, then creates the resource it would have
produced. It is the manual escape hatch for a payment the payer made (or that an
admin is mocking) whose webhook never arrived. It is deliberately narrower than
the replay endpoint: `boost` payments are excluded (they have no resource), and
the payment must still be `pending`.

- **Auth headers:** `X-Admin-Session` (preferred once 2FA is enabled) or the
  legacy `X-Admin-Key`. Rate-limited by `adminLimiter` (10/min/IP).
- **Body:** exactly one of `paymentId`, `invoiceId`, `phoneNumber` is required.
  When several are sent the precedence is `paymentId` > `invoiceId` >
  `phoneNumber`. A `phoneNumber` lookup takes the **most recent** matching
  pending payment (`sort: { createdAt: -1 }`). Selector length caps:
  `paymentId` 24, `invoiceId` 64, `phoneNumber` 20 characters.
- **Idempotency:** the claim atomically filters on `status: 'pending'`, so a
  double submit creates exactly one resource — the second call finds nothing
  pending and returns 404.
- **Marking:** the claim also sets `grantedBy` (the admin actor) and `grantedAt`
  on the payment, so a granted payment is distinguishable from a real one and is
  excluded from revenue.
- **Preview:** `POST /api/admin/grant-preview` takes the same body and validation
  but reads the matching payment (`Payment.findOne`, no update) and returns
  `{ success: true, payment: { id, type, package, storePlan, amount, createdAt,
  title, storeName, phoneMasked } }`. `title` (from `listingData.title`) and
  `storeName` (from `storeData.name`) are capped at 80 characters and null when
  absent; `phoneMasked` is first 4 + `***` + last 2 for a plain digit number,
  otherwise the stored value unchanged. The portal previews first and grants only
  the previewed id.

**Responses**

| Status | Body |
|---|---|
| 200 | `{ success: true, message: 'Free access granted', paymentId, resource: { type, id } }` |
| 400 | `{ success: false, error: 'Provide one of: paymentId, invoiceId, phoneNumber' }` / `{ success: false, error: 'Invalid selector' }` |
| 401/403 | `{ success: false, error: 'Admin 2FA required' }` / `{ success: false, error: 'Admin authorization required' }` |
| 404 | `{ success: false, error: 'No matching pending payment found' }` |
| 500 | `{ success: false, error: 'Grant free access failed' }` |

`POST /api/admin/grant-preview` responds `200 { success: true, payment }`, the
same `400` bodies, and `404 { success: false, error: 'No matching pending payment
found' }`; it never mutates the payment.


On success a `admin.grant_free_access` audit event is emitted
(`actor: admin:<username>`, `result: 'success'`).

**Example**

```bash
curl -X POST https://gikomart.onrender.com/api/admin/grant-free-access \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Session: <session-token>" \
  -d '{"invoiceId":"INV-EXAMPLE-1"}'
```

```json
{
  "success": true,
  "message": "Free access granted",
  "paymentId": "65f...",
  "resource": { "type": "listing", "id": "65f..." }
}
```

## i) Default location values (institution-neutral)

No route, environment variable or rate limiter changed as part of the
institution-neutral cleanup. The only API-visible change is the value that new
records carry by default: `Store.campus` now defaults to `'Njoro'` (the field is
still returned by the public store endpoints), `Listing.location` defaults to
`'Njoro'`, and the store-creation fallback in
`src/controllers/paymentController.js` is `'Njoro'`. Existing records are
unchanged.

## j) Free Grant (admin-approved free package)

Free Grant lets a seller request a free package, which an admin reviews and
approves; the seller then redeems it. It bypasses **payment acquisition only** —
provisioning, moderation, ownership, expiry and listing limits are the same as a
paid purchase, because redemption calls the same `createResourceForPayment()`.
No `Payment` row is written and no revenue is recorded.

Flow:

1. `POST /api/grants` with `{ type, whatsapp, package | storePlan, website }`.
   The number is normalized to `254[17]\d{8}`; the type/package are validated
   against `LISTING_PRICES`/`STORE_PLANS`; a blocked contact gets `403`. Responds
   `201 { claimId, claimToken, status: 'pending' }`. Only `sha256(claimToken)` is
   stored — the raw token is returned once, for the requesting browser only.
2. The admin reviews `GET /api/admin/grants` (session-gated; the full
   normalized number is returned as `whatsapp` for wa.me contact, with
   `whatsappMasked` kept — never on any public endpoint, and a session-less
   request leaks nothing; each row also reports a derived `provisioned`
   boolean) and calls `POST /api/admin/grants/:id/approve` or `/reject`
   (atomic `pending → approved|rejected`). The body is not trusted for
   package/number. The queue's `status` filter accepts
   `pending | approved | rejected` (pending default; an unknown value falls
   back to pending); the admin portal's additional `provisioned` view is
   derived client-side by fetching `status=approved` and filtering rows whose
   `provisioned` is true — the API itself has no such status value. The list
   payload never contains the claim token or its hash.
3. `GET /api/grants/status/:claimId` (header `X-Grant-Token`) reports
   `pending | approved | rejected`.
4. `POST /api/grants/:claimId/redeem` (header `X-Grant-Token`, body
   `{ listingData | storeData, acceptance }`) claims the redemption
   atomically (`status: 'approved'` AND `provisioned: null`, with an epoch-0
   in-flight sentinel and rollback to `provisioned: null` on failure), mints
   the owner token in the seller's request, records terms acceptance, and
   calls `createResourceForPayment()` with the request `_id` as the
   unique-sparse `paymentId`. Responds `201 { resource: { type, id },
   ownerToken }` (returned once). A repeat redeem returns
   `200 { alreadyProvisioned: true, resource }` without creating a second
   resource; a rejected or not-yet-approved request gets `409`; a
   concurrent redemption while another holds the claim resolves to the
   winner's outcome or a retryable `409`. A redeemed LISTING is broadcast
   through the same `broadcastListing` as the paid webhook path — only when
   moderation approved it, fire-and-forget; store grants never broadcast.
5. Continuation: the claim token lives only in the submitting browser's
   localStorage. To move it, the seller's pending card offers **Copy WhatsApp
   message** — one click puts the whole handoff on the clipboard (request
   description, contact number, and the private `#grant=<claimId>/<token>`
   URL HASH fragment link with a keep-it-private note; purely client-side,
   the token never rendered into the page, and an honest link-free message
   when no token is readable). The Continue-on-another-device dialog builds
   the same style of fragment link on its own; `app.js` captures and scrubs
   the hash at script-parse time (never sent to a server, never in Referer —
   `index.html` sets `Referrer-Policy: no-referrer`) and resumes through the
   normal poll flow.
   When the token is lost entirely, an admin can deliberately mint a NEW
   credential: `POST /api/admin/grants/:id/continuation-token` (session
   gate; `adminLimiter`; empty body) atomically replaces the stored
   `claimTokenHash` for an approved, not-yet-provisioned grant, which
   revokes the old token by the write itself. Responds
   `200 { success, claimId, claimToken, message }` — the raw token is
   returned ONLY in this response, never via `GET /api/admin/grants`, never
   logged or audited. Errors: `400` malformed id, `404` unknown grant,
   `409` pending/rejected/provisioned (a redemption in flight counts as
   provisioned for this check). No schema change — the same
   `claimTokenHash` field and timing-safe comparison are reused. Abuse
   watch: each mint fire-and-forgets a volume evaluation over the audit
   trail (1-hour window, threshold `GRANT_MINT_ALERT_THRESHOLD`, default 5)
   that logs and records `admin.grant_mint_volume_alert` when unusual —
   advisory only; it never blocks or limits minting.
6. QA/test marker: agent-submitted test requests can be flagged so the queue
   separates them from real sellers. `POST /api/admin/grants/:id/qa-flag`
   (session gate; `adminLimiter`; body `{ isTest: boolean }`) sets the flag
   on a request of ANY status and responds `200 { success, grantId, isTest }`
   (`400` malformed id, `404` unknown grant, `401` session-less). The flag is
   cosmetic only — approve/reject/redeem/mint behave identically for marked
   requests — and is correctable at any time. `GET /api/admin/grants` returns
   `isTest` per row and accepts an optional `?isTest=true|false` filter
   (absent → unfiltered); the admin portal renders a **QA/test** badge on
   flagged rows with a two-click Mark/Unmark toggle. Every toggle writes an
   `admin.grant_test_flag_set` audit event carrying only `{ isTest }`.

Rate limiting reuses existing limiters (submit = `reportLimiter`, status =
`statusLimiter`, redeem = `paymentLimiter`). Admin routes use `adminLimiter` and
the session-only gate. No environment variable was added.
