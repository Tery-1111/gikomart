# Architecture — Stores, Payments, Listings, Uploads

Mapped from the repository by a read-only review on 2026-10-07 (`main` @ `342e444`).
Every claim is repository truth (source code, E2); line references are valid at that
commit and will drift as code changes. Companion reading: `docs/API_AND_CONFIG.md`
(route/limiter table), `docs/security/AUDIT_INPUTS.md` §10 (upload security chain).

## 0. The one thing to get right first

**There is no image-quota system.** The codebase has no `imageQuota`, `imagesUsed`,
`canUpload`, `consumeUpload`, or `releaseUpload` anywhere, and no Package model. What
actually bounds usage:

1. **Store plans cap *listings*, not images** — 5 / 10 / 15 active listings per store
   (`listing_limit`, enforced at attach time by a live count).
2. **Every listing carries at most 6 image URLs** (`listing.images.maxItems`), the same
   for every plan — and the sell form currently uploads only one image anyway.
3. **Uploads themselves are stateless and unauthenticated** — bounded by rate limits and
   the 24-hour orphan sweep, not by any per-user quota.

## 1. Big picture

```
                 ┌── POST /api/upload ──► Cloudinary ──► Upload record (attached:false)
                 │        (public, chain of 11 controls, no auth)
SELLER (browser) │
                 ├── POST /api/payments/initiate-listing   (package + listingData + image URLs)
                 └── POST /api/payments/initiate-store-plan (plan + storeData)
                          │  STK push via IntaSend
                          ▼
                    IntaSend ──► POST /api/payments/webhook
                          │       (challenge check → validate-before-complete → atomic claim)
                          ▼
                 createResourceForPayment(payment)
                   ├── type=listing → Listing.create (package caps, expiresAt)
                   └── type=store   → Store.create  (plan baked in: listing_limit, expires_at)
                          │
                          ▼
                 Owner receives raw owner token ONCE (stored only as sha256)
                   └── PUT /api/stores/:id/attach-listing  (listing_limit enforced HERE)
                   └── PUT /api/listings/:id  (edit, X-Owner-Token)
                   └── DELETE /api/stores/:id  (cascade, X-Owner-Token or admin)
```

Listings are **never created directly by users** — there is no `POST /api/listings`.
Every listing is born from a completed payment: webhook, admin replay, or a Free Grant
redemption (which synthesizes a payment-shaped object and funnels through the same
`createResourceForPayment`).

## 2. Models

### Store (`src/models/Store.js`)
- Identity: `name`, `slug` (unique), `description`, `logo_url`, `cover_url`.
- Business/contact/location: `category`, `subcategories[]`, `phone`, `whatsapp`,
  `email`, `campus`, `location`, `pickup_location`, hours, `payment_methods[]`.
- Trust: `verification_status` (unverified/pending/verified),
  `moderationStatus` (approved/flagged/removed — `removed` flips `status` to `suspended`).
- Ownership: `ownerTokenHash` — sha256 of the one-time token, `select: false`,
  **unique index** (one store per owner token → one store per owner).
- Payment linkage: `paymentId` — **unique sparse index** (webhook idempotency).
- Plan block (immutable after creation): `plan` ∈ `starter_weekly | standard_monthly |
  pro_monthly`, `plan_price`, `plan_duration`, `listing_limit` (Number, required),
  `started_at`, `expires_at`; `status` ∈ active/expired/suspended.

### Listing (`src/models/Listing.js`)
- `status` ∈ active/sold/deleted; `moderationStatus` ∈ approved/flagged/removed.
- `images: [String]` — Cloudinary URLs; capped at **6 items** server-side.
- `expiresAt` (indexed for the cleanup job), `ownerTokenHash` (select:false),
  `store_id: ObjectId|null` (indexed) — the only link between a listing and a store.
- Featured/boost fields exist (`featured: -1` in the browse index).

### Payment (`src/models/Payment.js`)
- `type` (listing/store/boost), `package` or `storePlan`, embedded
  `listingData`/`storeData` payloads, `ownerTokenHash`, `status`
  (`pending` → … → `completed` one-way; see CHANGELOG on the no-unapprove guard),
  `{ status: 1, createdAt: -1 }` index (perf U3).

### Upload (`src/models/Upload.js`)
- `publicId` (unique), `url`, `attached` (default false), `createdAt` (indexed).
- Pure bookkeeping for the orphan sweep — nothing reads it except cleanup.

## 3. Catalog (single source of truth: `src/services/paymentService.js:16-29`)

| Catalog | Tier | Price (KES) | Duration | Cap |
|---|---|---|---|---|
| `LISTING_PRICES` | `quick` | 30 | 24 h | 1 listing |
| | `standard` | 50 | 7 d | |
| | `premium` | 150 | 30 d | |
| `STORE_PLANS` | `starter_weekly` | 150 | 7 d | **listingLimit: 5** |
| | `standard_monthly` | 200 | 30 d | **listingLimit: 10** |
| | `pro_monthly` | 300 | 30 d | **listingLimit: 15** |
| `BOOST_PRICES` | (boost tiers) | — | — | featured flag |

A `standard_weekly` store plan was removed (audit Fix 6) — same price/limit as
`standard_monthly` but never sellable from the UI; deleting it closed a crafted-request path.

## 4. Store lifecycle

### 4.1 Plan selection (frontend)
`public/index.html` store form → `app.js` renders the three plans as selectable cards
(`#storePlanOptions`, app.js:1802) → `POST /api/payments/initiate-store-plan` with
`{ phoneNumber, storePlan, storeData, acceptance }` (app.js:1869-1872).

### 4.2 Initiation (`paymentController.initiateStorePlan`, :320)
Route chain: `paymentLimiter + listingCreateLimiter + honeypot` (payments.js:10).
Server-side validation before the SDK call: `STORE_PLANS[storePlan]` must exist and the
**amount is pinned to the catalog value** (client price is never trusted); `storeData`
is bounded by the `inputLimits.store` allowlist (character caps, `subcategories` ≤ 12,
`payment_methods` ≤ 10); blocked-contact check; moderation pre-scan (`checkStore`);
store logo/cover URLs http(s)-validated and marked attached pre-push (`paymentController.js:389`).

### 4.3 Birth from the webhook (`createResourceForPayment`, :477; store branch :520-549)
`Store.create` copies plan facts from the catalog (`listing_limit: pricing.listingLimit`,
`expires_at = now + pricing.durationMs`), sets `ownerTokenHash` from the payment,
`status: 'active'`, and moderation from the pre-scan. **Idempotency:** a duplicate
webhook delivery hits the unique `paymentId` index (`code 11000`) and the handler
re-reads the existing store instead of failing. The same payment cannot mint two stores.

### 4.4 Owner management (all under `src/routes/stores.js`)
- `GET /slug/:slug` — public read; owner token (if supplied) unlocks private fields via
  constant-time hash compare (storeController.js:56-65).
- `GET /me/all` — owner's stores (X-Owner-Token).
- `PUT /:id` — update store fields (`storeAuth({ requireActive: true })`).
- `PUT /:id/attach-listing` / `PUT /:id/detach-listing` — the quota system (below).
- `DELETE /:id` — cascade delete (store + its listings + Cloudinary assets,
  transactional; `storeAuth({ allowAdmin: true })`).
- Admin: `PUT /api/admin/stores/:id/moderate`, `PUT /api/admin/stores/:id/suspend`
  (adminAuth.js:45-46, `adminAuth` = 2FA session).

## 5. Limits — how the "quota" really works

### 5.1 Store listing limit (the 5/10/15)
`storeController.attachListing` (:307) guard order:

1. `storeAuth({ requireActive: true })` — owner token or admin; store must be active.
2. Listing not already in **any** store (`listing.store_id` → 400).
3. Listing not expired (400).
4. **The limit:** `countDocuments({ store_id: store._id, status: 'active' }) >= store.listing_limit`
   → 400 `Store listing limit reached (N). Upgrade your plan or remove existing listings.` (:344-350)
5. Listing `moderationStatus !== 'removed'` (409 — terminal state).
6. Attach: `listing.store_id = store._id; await listing.save()` + audit event.

Key properties: the count is **computed live at attach time** — there is no persisted
counter to increment or decrement, so `detachListing` (:375, clears `store_id`) frees a
slot with no bookkeeping, and sold/deleted/expired listings do not consume capacity.

### 5.2 Per-listing image cap (6, flat)
`inputLimits.listing.images.maxItems: 6` enforced on every write path:
payment initiation (`paymentController.js:196`), owner updates
(`listingController.js:183`), grants (`grantController.js:68`); URLs must be http(s)
(`paymentController.js:181-182`). The **UI uploads one image** (single `#f-image` file
input, index.html:149), so in practice the cap binds hostile/oversized URL arrays, not
the current form.

### 5.3 What does NOT exist
- No image-quota counters, per-plan image allowances, or quota tables.
- No plan-upgrade endpoint — the 400 message's "Upgrade your plan" has no API behind it
  (and `ownerTokenHash`'s unique index means "another store" = new payment + new store).
- No admin quota adjustment (admin store surface = moderate/suspend/delete only).
- No direct store/listing creation routes.
- No image upload in the store form — `logo_url`/`cover_url` are render-only today.

## 6. Upload pipeline (`src/routes/upload.js` — POST /api/upload, public by decision)

Full chain (see AUDIT_INPUTS §10 for the documented decision and rationale):

```
uploadLimiter (10/min/IP) → uploadDailyLimiter (100/24h/IP)
→ multer memoryStorage, 3 MB, single 'image' field
→ magic-byte sniffing (file-type): jpeg/png/webp/gif only
→ decode semaphore (3 concurrent / 10 queued → 503 + requestId)
→ sharp: limitInputPixels 25 MP → rotate → resize 1280×1280 inside → jpeg q80
→ Cloudinary (allowed_formats, folder gikomart)
→ Upload.create({ publicId, url, attached: false })
```

**Orphan economics:** every upload starts unattached and is destroyed by
`destroyOrphanUploads` (cleanupService.js:83-93) after 24 h unless a payment referenced
its URL — `markUploadsAttached` (paymentController.js:43-54) flips `attached: true` for
listing images (post-validation, pre-SDK) and store logo/cover (:243, :389). This is the
system that bounds anonymous storage abuse; see the keep-public decision record in
AUDIT_INPUTS §10.

## 7. Ownership & auth model

- **Owner token:** raw 128-bit-ish token shown **once** at creation; only
  `sha256(token)` is stored (`ownerTokenHash`, select:false). Sent as `X-Owner-Token`
  on edits/attaches; compared with `timingSafeEqual` after length check. No revocation.
- **Store auth:** `storeAuth({ requireActive | allowAdmin })` — owner hash or admin.
- **Admin:** `adminAuth` (HMAC 24 h session behind the TOTP gate) for moderate/suspend;
  `requireAdminSession` for replay/audit-logs; admin replay re-runs
  `createResourceForPayment` (idempotent via the same unique indexes).

## 8. Expiry & cleanup (`src/services/cleanupService.js`, every 30 min)

- `deleteExpiredListings` (:44) — hard-deletes expired listings incl. Cloudinary assets
  and their seller PII (window = package duration; ≤ 30 d).
- `expireStores` (:266) — flips `status → 'expired'` at `expires_at`; store contact PII
  is retained (documented gap, not in scope here).
- Orphan upload sweep (above, 24 h).

## 9. Flow walkthroughs

**Sell (single image):** upload → `POST /api/payments/initiate-listing`
(`{ package, listingData: {…6 URLs max…}, acceptance }`) → STK push → webhook →
`Listing.create` + `markUploadsAttached` → owner token displayed once.

**Store:** pick plan card → `initiate-store-plan` → STK push → webhook → `Store.create`
(5/10/15 baked in) → owner token once → owner attaches listings one by one until the
live count hits `listing_limit` → 400 with the (currently aspirational) upgrade message.

**Recovery:** manual status check (app.js:1933) or admin replay — both safe against the
atomic webhook claim (`findOneAndUpdate` on invoiceId with status guard).

## 10. Verification appendix (re-derive any claim)

```bash
git rev-parse --short HEAD                     # doc valid at 342e444
sed -n '16,29p' src/services/paymentService.js # catalogs + 5/10/15
grep -rn "imageQuota\|imagesUsed\|canUpload" src/ public/assets/js/app.js  # → empty
grep -n "listing_limit" src/controllers/storeController.js  # attach-time check
grep -n "maxItems" src/config/inputLimits.js   # images: { maxItems: 6 }
grep -n "router\." src/routes/listings.js      # no POST — payments create listings
sed -n '520,549p' src/controllers/paymentController.js       # store birth + idempotency
sed -n '344,350p' src/controllers/storeController.js         # the limit check
```
