# Phase 9b — Exit Gate Report

Branch: `fix-grant-accounting` (created from `main` @ `0ce63b2`, the Phase 8b merge).
Working tree at gate time: clean. Nothing pushed or merged.

## Commits

Three commits on top of `main`, in order; the report commit is the fourth.

| # | Commit | Message |
|---|--------|---------|
| 1 | `9f635ac` | `feat(admin): mark payments completed by an admin grant` |
| 2 | `a00c44d` | `feat(metrics): exclude admin grants from revenue and count them separately` |
| 3 | `a22738f` | `feat(admin): preview before granting and cap grant selectors` |
| 4 | (this report) | `docs: phase 9b gate report` |

## Baseline and reconciliation

`npm test` before Step 1 recorded **BASE_FILES = 35**, **BASE_TESTS = 464**.

| State | Files | Tests | Added files | Added tests |
|-------|-------|-------|-------------|-------------|
| Baseline `main` @ `0ce63b2` | 35 | 464 | — | — |
| After Step 1 (`9f635ac`) | 36 | 467 | `tests/grantMarking.test.mjs` | +3 |
| After Step 2 (`a00c44d`) | 37 | 471 | `tests/adminMetricsGrants.test.mjs` | +4 |
| After Step 3 (`a22738f`) | 39 | 489 | `tests/grantPreview.test.mjs`, `tests/grantPortal.test.mjs` | +13, +5 |
| After Step 4 (docs only) | 39 | 489 | — | +0 |

Reconciliation: `464 + 3 + 4 + 13 + 5 = 489` ✅ and `35 + 1 + 1 + 2 = 39` ✅
(the three edited existing test files add no count).

Per new file: `tests/grantMarking.test.mjs` 3, `tests/adminMetricsGrants.test.mjs` 4,
`tests/grantPreview.test.mjs` 13, `tests/grantPortal.test.mjs` 5.

## Verification

```
npm test  → Test Files 39 passed (39) | Tests 489 passed (489) | Duration 53.02s
npm run lint → clean (eslint . → exit 0)
```

`git diff --check main..HEAD` → no output (exit 0).
`git diff --stat main..HEAD` → 14 files changed, 1189 insertions(+), 44 deletions(-).
`git diff --name-status main..HEAD -- tests/` shows only `A` lines plus the three
approved `M` lines (no unapproved existing-test edits).

`git diff --stat main..HEAD -- src/ public/`:
```
 public/assets/js/admin.js      |  85 ++++++++++++++++++++++----
 src/models/Payment.js          |   5 ++
 src/routes/adminGrant.js       | 134 ++++++++++++++++++++++++++++++++++-------
 src/services/metricsService.js |   9 ++-
 4 files changed, 199 insertions(+), 34 deletions(-)
```

## Existing tests changed across Steps 1–3

Exactly three existing test files were changed, each with explicit approval; no
existing test was skipped, deleted, or weakened.

| File | Step | Exact change |
|------|------|--------------|
| `tests/adminMetrics.test.mjs` | 2 | `Payment.countCalls` expected list gains `{ status: 'completed', grantedAt: { $ne: null }, createdAt: { $gte: SINCE30 } }`; `totalCountCalls` 10 → 11; test name "ten" → "eleven"; `EXPECTED_PIPELINE` `$match` gains `grantedAt: null`; `Object.keys(r.payments)` and `r.payments` gain `granted30d`. |
| `tests/adminPortal.test.mjs` | 2 | `EXPECTED_METRICS` gains `['payments.granted30d', 'Free grants (30 days)', '3']` directly after `payments.failed24h`; fixture `metricsData().payments` gains `granted30d: 3`; test name "sixteen metrics" → "seventeen metrics". |
| `tests/adminGrant.test.mjs` | 3 | One JSDOM admin UI case: added a Preview step (stub `POST /api/admin/grant-preview` returns payment id `pay-ui`) and changed the expected grant body from `{ invoiceId: 'INV-GRANT-1' }` to `{ paymentId: 'pay-ui' }`, asserting exactly the key `['paymentId']`. |

Every other existing test file is unchanged.

## What changed

- **`src/models/Payment.js`** — `grantedBy` (String, default null) and `grantedAt`
  (Date, default null).
- **`src/routes/adminGrant.js`** — the atomic claim stamps `grantedBy`/`grantedAt`;
  the `admin.grant_free_access` audit metadata gains an ISO `grantedAt`; new
  read-only `POST /grant-preview`; shared selector caps (24/64/20) on both routes.
- **`src/services/metricsService.js`** — revenue `$match` excludes grants
  (`grantedAt: null`); new `payments.granted30d` count.
- **`public/assets/js/admin.js`** — dashboard "Free grants (30 days)" metric;
  Grant tab gains a Preview button with preview-gated Grant.
- **`docs/CHANGELOG.md`, `docs/DECISIONS.md` (30, 31), `docs/API_AND_CONFIG.md`.**

## Failures encountered and how they were handled

- Step 2 initially reddened `tests/adminMetrics.test.mjs` and
  `tests/adminPortal.test.mjs` (exact filter/count/keys). Stopped and asked;
  both were then approved for edit and updated (above).
- Step 3 initially reddened the pre-existing JSDOM UI case in
  `tests/adminGrant.test.mjs`. Stopped and asked; that single case was then
  approved for edit and updated (above).

No failure was resolved without explicit approval, and no existing test was
weakened, skipped, or deleted. Nothing was pushed or merged.
