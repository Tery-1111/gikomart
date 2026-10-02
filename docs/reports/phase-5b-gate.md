# Phase 5B — Exit Gate Report

Branch: `phase-5b-reports` (from `phase-5a-blocks` @ `93d336c`)
Baseline: `93d336c` — 18 test files / 285 tests passing.

## 1. Test suite

`npm test` → **20 test files passed (20) · 322 tests passed (322)**.

Delta vs baseline: **+2 files** (`tests/reportLimiter.test.mjs`,
`tests/retentionReportsPayments.test.mjs`) and **+37 tests** (285 → 322). New
tests: Step 1 +11 (6 phone keyed-hash, 5 envGuard), Step 2 +15 (13 wiring
report, 2 reportLimiter), Step 3 +5 (wiring audit events), Step 4 +6
(retentionReportsPayments). Every new test was written first and observed to
fail against the unmodified source before the fix (see §4).

## 2. Lint and whitespace

- `npm run lint` → clean (exit 0, no output).
- `git diff --check phase-5a-blocks..phase-5b-reports` → clean (no whitespace
  errors, no line-ending inflation).

## 3. Diff stat (`phase-5a-blocks..phase-5b-reports`)

```
 .env.example                            |   4 +
 docs/API_AND_CONFIG.md                  |  55 +++++
 docs/CHANGELOG.md                       |  68 ++++++
 docs/DECISIONS.md                       |  51 +++++
 docs/runbook-moderation.md              |  42 ++++
 server.js                               |   1 +
 src/config/envGuard.js                  |   9 +
 src/config/inputLimits.js               |   4 +
 src/controllers/adminController.js      |  14 ++
 src/controllers/listingController.js    |  25 +++
 src/controllers/reportController.js     | 191 ++++++++++++++++
 src/controllers/storeController.js      |  28 +++
 src/middleware/rateLimiter.js           |  13 +-
 src/models/Payment.js                   |   4 +
 src/models/Report.js                    |  32 +++
 src/routes/adminAuth.js                 |   8 +-
 src/routes/reports.js                   |  16 ++
 src/services/cleanupService.js          |  62 +++++-
 src/utils/phone.js                      |  27 ++-
 tests/adminLockout.test.mjs             |   1 +
 tests/envGuard.test.mjs                 |  37 ++++
 tests/phone.test.mjs                    |  57 ++++-
 tests/reportLimiter.test.mjs            |  31 +++
 tests/retentionReportsPayments.test.mjs | 193 +++++++++++++++++
 tests/wiring.test.mjs                   | 372 ++++++++++++++++++++++++++++++++
 25 files changed, 1336 insertions(+), 9 deletions(-)
```

No line-ending inflation. The 9 deletions are all accounted for: the
`rateLimiter.js` `module.exports` line (extended with `reportLimiter`), the
`adminAuth.js` `module.exports = router;` line (moved below the new reports
routes), the `cleanupService.js` scheduler log line and `module.exports` closing
brace (both rewritten), the 3-line `contactHash` comment plus the
`crypto.createHash(...)` line in `phone.js` (replaced by the keyed version), and
the `tests/phone.test.mjs` `vitest` import line (extended with `afterEach`).

## 4. Commits

`git log --oneline phase-5a-blocks..phase-5b-reports` shows **exactly four**
feature commits, plus this report commit (the fifth):

```
21dbd7e feat(retention): strip report IPs and old payment PII
184daf4 feat(audit): events for listing edits, auto-flags, attach/detach and payment views
80caf13 feat(reports): public report submission with admin queue and resolution
6c56f21 feat(blocks): key contact hashes with BLOCK_HASH_SECRET
```

Fail-first evidence per step: Step 1 — with the source stashed, 7 of the new
phone/envGuard tests failed; Step 2 — 13 report tests failed and
`tests/reportLimiter.test.mjs` failed to load with `reportLimiter` undefined;
Step 3 — all 5 audit-event tests failed; Step 4 — all 6 retention tests failed
with `stripOldReportPII is not a function` / `stripOldPaymentPII is not a
function`.

## 5. `TEMPLATE` scan

`grep -in TEMPLATE` over every file changed on the branch → **no matches** in
any of the 25 files.

## 6. Existing tests / fakes changed

| File | Exact change | Authorized by |
|---|---|---|
| `tests/adminLockout.test.mjs` | one line `reportLimiter: pass(),` added to the hand-written fake rate-limiter module | Global rule A |
| `tests/phone.test.mjs` | the `vitest` import line gained `afterEach`; a `node:crypto` import was added (test-only import, no assertion, status or test name changed) | Step 1 test instruction (afterEach save/restore) |
| `tests/envGuard.test.mjs` | additions only — no existing line changed | Step 1 test instruction |
| `tests/wiring.test.mjs` | all additions, no existing line removed: a fake `Report` model (create / findOne / find / findById / findByIdAndUpdate) and its `injectModule` line; `h.reports` plus its reset in the global `beforeEach`; a `$gte` branch added to the generic `matchesFilter` helper; a `reportLimiter` passthrough in the fake rate-limiter module | Global rule B |

No other existing test line was changed. `git diff` against `phase-5a-blocks`
shows **0 removed lines** in `tests/wiring.test.mjs` and
`tests/envGuard.test.mjs`, and exactly 1 (the import line) in
`tests/phone.test.mjs`.

## 7. Confirmations

**(a) PII never logged, emitted, returned or used as a docs example.**
`reporterIp` appears only in: `docs/API_AND_CONFIG.md` (retention table, field
name), `docs/CHANGELOG.md` (field name), `src/controllers/reportController.js`
(variable used for the dedupe lookup and the `Report.create` payload — never in
a response body), `src/models/Report.js` (schema field),
`src/services/cleanupService.js` (retention filter/target),
`tests/retentionReportsPayments.test.mjs` and `tests/wiring.test.mjs` (fixtures).
`grep -rEn "[0-9]{9,}" src/ docs/` → no phone-like digit runs (external of the
`6500000000000000000000` test-id prefix). `contactHash` appears in `docs/` only
as a descriptive identifier (CHANGELOG, DECISIONS, the Phase 5A gate report),
never as a hash value. Every response builder omits `reporterIp` and
`contactHash`.

**(b) No existing `emit()` call was changed.**
`git diff phase-5a-blocks..phase-5b-reports | grep -E "^-.*emit\("` → no
matches. The phase added new `emit()` calls only.

**(c) `initiateBoost`, the webhook, `createResourceForPayment` and
`replayPayment` are unchanged.**
`git diff --stat phase-5a-blocks..phase-5b-reports -- src/controllers/paymentController.js
src/controllers/adminAuthController.js src/routes/payments.js` → empty.
`paymentController.js` (which holds `initiateBoost`, the webhook handler,
`createResourceForPayment`) and `adminAuthController.js` (which holds
`replayPayment`) do not appear in the branch diff at all.

**(d) Does `replayPayment` read `Payment.phoneNumber` or
`listingData.sellerWhatsapp`?**
No. `grep -n "phoneNumber\|sellerWhatsapp\|listingData\|storeData"
src/controllers/adminAuthController.js` → no matches. It loads the payment by
invoice id and delegates the whole record to `createResourceForPayment`:

```
336:    const payment = await Payment.findOne({ invoiceId: paymentReference });
396:    const { type, doc } = await createResourceForPayment(payment);
```

## 8. REPORT ONLY — TermsAcceptance fields that can still identify a person

`stripOldAcceptancePII` nulls `actor.ip`, `actor.phoneHash` and
`actor.userAgent`. The following schema fields can still identify a person or a
phone number afterwards (schema lines from `src/models/TermsAcceptance.js`):

```
  actor: {
    phoneHash: { type: String },            // nulled by the job
    whatsappHash: { type: String },         // NOT nulled — hash of a phone number
    ownerTokenHash: { type: String },       // NOT nulled — sha256 of an owner token
    ip: { type: String },                   // nulled by the job
    userAgent: { type: String },            // nulled by the job
  },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' },
  sellerContactTarget: {
    sellerWhatsappHash: { type: String },   // NOT nulled — hash of the seller number
    listingTitle: { type: String },
  },
  metadata: { type: mongoose.Schema.Types.Mixed },  // NOT nulled — arbitrary content
```

Still-identifying: `actor.whatsappHash` (brute-forceable over the Kenyan number
space), `actor.ownerTokenHash` (a credential hash), and
`sellerContactTarget.sellerWhatsappHash` (seller number hash); plus the
`storeId`/`listingId` linkage ids and the free-form `metadata` bag. This is
reported only — nothing was changed.

## 9. UNVERIFIED

- **Live MongoDB semantics.** The unique sparse indexes on `Report` and on
  `BlockedContact.contactHash`, real duplicate-key (E11000) behavior, the actual
  `$nin`/`$ne`/`$gte`/`$lte` matching of the new queries, and nested `$unset`
  behavior (`listingData.sellerWhatsapp`, etc.) are **NOT ESTABLISHED FROM
  AVAILABLE EVIDENCE**; the task forbids starting the server against a database.
- **Keyed-hash persistence.** That a real `BlockedContact` row written before
  this phase no longer matches the new HMAC hash is documented behavior, not
  runtime-verified (no database).
- **Production startup refusal.** `assertStartupConfig`'s `BLOCK_HASH_SECRET`
  gate is verified in isolation (E3); the real `process.exit(1)` path at
  `node server.js` startup is UNVERIFIED.
- **`req.ip` behind the proxy.** Report deduplication is verified at the app
  layer; the real client IP under Render/Cloudflare depends on `TRUST_PROXY`,
  which is unchanged and not exercised here.
- **External systems.** IntaSend, Whapi and Cloudinary behavior is unchanged and
  out of scope; REQUIRES EXTERNAL VERIFICATION.

No external action was performed. Phase 6 is not started.
