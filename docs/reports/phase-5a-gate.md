# Phase 5A — Exit Gate Report

Branch: `phase-5a-blocks` (from `docs-changelog` @ `97cc19e`)
Baseline: `97cc19e` — 17 test files / 253 tests passing.

## 1. Test suite

`npm test` → **18 test files passed (18) · 285 tests passed (285)**.

Delta vs baseline: **+1 file** (`tests/phone.test.mjs`) and **+32 tests**
(253 → 285). The task anticipated "about 253 plus roughly 40 new"; the actual
new count is 32 (Step 1: 8, Step 2: 10 + 7 phone unit tests, Step 3: 7). All
pass.

## 2. Lint and whitespace

- `npm run lint` → clean (no output, exit 0).
- `git diff --check docs-changelog..phase-5a-blocks` → clean (no whitespace
  errors, no CRLF/`^M` inflation).

## 3. Diff stat (`docs-changelog..phase-5a-blocks`)

```
 docs/API_AND_CONFIG.md               |   3 +
 docs/CHANGELOG.md                    |  43 +++++
 docs/DECISIONS.md                    |  34 ++++
 docs/runbook-moderation.md           |  34 ++++
 src/controllers/blockController.js   | 143 ++++++++++++++
 src/controllers/listingController.js |  27 ++-
 src/controllers/paymentController.js |  42 +++-
 src/models/BlockedContact.js         |  15 ++
 src/routes/adminAuth.js              |   7 +
 src/utils/phone.js                   |  23 +++
 tests/phone.test.mjs                 |  50 +++++
 tests/wiring.test.mjs                | 363 ++++++++++++++++++++++++++++++++++-
 12 files changed, 780 insertions(+), 4 deletions(-)
```

No line-ending inflation. The 4 deletions are accounted for: two moved lines in
`listingController.js` (the `pageNum`/`limitNum` lines relocated above the
store-visibility gate, values unchanged), the `auditService` import line in
`paymentController.js` (extended with `ownerActor`), and the fake Store `findOne`
line in `tests/wiring.test.mjs` (see §6).

## 4. Commits

`git log --oneline docs-changelog..phase-5a-blocks` shows **exactly three**
commits:

```
d345f24 feat(blocks): refuse payment initiation for blocked contacts
96b1a23 feat(blocks): admin seller block list keyed by hashed normalized number
29f8302 fix(stores): hide inventory of suspended, flagged or removed stores
```

This report is the fourth (and final) commit on the branch.

## 5. `TEMPLATE` scan

`grep -ni TEMPLATE` over every changed file → **no matches**.

## 6. Existing tests / fakes changed

Only `tests/wiring.test.mjs` was modified among existing test files. The **only**
existing line that changed is the fake Store `findOne` predicate:

```diff
-        if (slugOk && statusOk && modOk) { ... }
+        const idOk = matchesStoreId(s._id, filter._id);
+        if (idOk && slugOk && statusOk && modOk) { ... }
```

plus the new bounded `matchesStoreId` helper (plain equality, `$ne`, `$nin`,
`$in`; a missing stored id passes `$ne`/`$nin`). This is Authorization A. No
fixture, assertion or test name was altered.

All other changes to `tests/wiring.test.mjs` are additions: the fake
`BlockedContact` model (per the Step 2 spec: `create`, `findOne` with equality
and `$in` on `contactHash`, `find` with `sort`/`limit`/`lean`,
`findByIdAndDelete`), its injection line, the shared `h.blocks` state and its
reset, and three new `describe` blocks (Step 1: 8 tests, Step 2: 10 tests,
Step 3: 7 tests).

**No other test file was modified.** Authorization B (adding a fake
`BlockedContact` to other files) was **not needed** — no existing test outside
`wiring.test.mjs` reaches the new payment-initiation code path, so the full
suite passed without extra fakes. No failure appeared that required it.

## 7. Final store-visibility code in `getListings`

```js
if (req.query.store_id) {
  const storeId = req.query.store_id;
  const validStoreId = typeof storeId === 'string'
    && mongoose.isValidObjectId(storeId)
    && /^[0-9a-fA-F]{24}$/.test(storeId);
  const visibleStore = validStoreId
    ? await Store.findOne({
        _id: storeId,
        status: { $ne: 'suspended' },
        moderationStatus: { $nin: ['flagged', 'removed'] },
      })
    : null;
  if (!visibleStore) {
    return res.json({ success: true, count: 0, total: 0, page: pageNum, totalPages: 0, listings: [] });
  }
}
```

Requests without `store_id` skip this block entirely.

## 8. No phone number or hash leaks

Files where `contactHash` appears:

- `src/utils/phone.js` (definition, lines 17, 23)
- `src/models/BlockedContact.js` (field definition and comment, lines 5, 8)
- `src/controllers/blockController.js` (lines 6, 55, 64, 69, comment 95)
- `src/controllers/paymentController.js` (lines 20, 26, 28)

No `contactHash` appears anywhere under `docs/`.

No code path writes a phone number or `contactHash` into a log call, an audit
emit, or a response body:

- `src/utils/phone.js`, `src/models/BlockedContact.js` and
  `src/controllers/blockController.js` contain **no `logger` calls at all**.
- `admin.block_added` metadata = `{ sourceType, sourceId, created, alreadyBlocked }`;
  `admin.block_removed` metadata = `{}`.
- `payment.blocked_contact` metadata = `{ route: 'initiate-listing' | 'initiate-store-plan' }`.
- `POST /blocks` responds `{ success, created, alreadyBlocked }` (no number, no hash);
  `GET /blocks` maps only `id, sourceType, sourceId, reason, createdBy, createdAt`;
  `DELETE /blocks/:id` responds `{ success: true }`; the payment refusal responds
  `{ success: false, error }`.

`grep -ni contactHash docs/` → no matches; docs use no phone numbers (placeholders
only).

## 9. Behavioral statements

(a) **No existing route calls `BlockedContact` or `Store` more often than
before for requests without the new inputs.** `GET /api/listings` only reaches
`Store.findOne` inside `if (req.query.store_id)`; without `store_id` it never
touches `Store`. `BlockedContact` is reached only from the new `/api/admin/blocks`
routes and from `isContactBlocked` inside `initiate-listing`/`initiate-store-plan`.
`initiate-boost` does not call it.

(b) **`replayPayment` and the webhook are unchanged.** `replayPayment` lives in
`src/controllers/adminAuthController.js` (not on the branch). `handleWebhook`
lives in `src/controllers/paymentController.js` and is untouched — the branch
diff for that file contains only three hunks (the import line, the
`initiateListing` block check, the `initiateStorePlan` block check). No file
whose name matches `webhook` or `replay` was changed.

## 10. UNVERIFIED items

- **Live-MongoDB behavior.** All verification is E3/E4 against the fake models
  in `tests/wiring.test.mjs`. The `unique` index on `BlockedContact.contactHash`,
  Mongo's duplicate-key behavior under the real driver, and the actual
  `Store.findOne`/`$nin` query execution are **NOT ESTABLISHED FROM AVAILABLE
  EVIDENCE** (would require a running database; the task forbids starting the
  server against a database). Existing code paths already exercise the same
  Mongoose patterns.
- **IntaSend call observation.** The Step 3 tests assert `403` and that no
  `Payment` was created, but the suite has no existing seam to observe that the
  IntaSend start function was *not* called, so that third assertion is omitted
  (as the task permits). The source ordering (block check precedes the IntaSend
  call) is E2 only.
- Nothing else outstanding.

No external action was performed. Phase 5B is not started.
