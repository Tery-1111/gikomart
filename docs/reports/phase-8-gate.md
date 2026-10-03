# Phase 8 — Report and save/retry frontend hardening — Exit Gate Report

Branch: `phase-8-polish` (from `main` @ `950995d`)
Baseline: `main` @ `950995d` — 26 test files / 409 tests passing.

## 1. Test suite

`npm test` → **30 test files passed (30) · 432 tests passed (432)**, duration
**32.71s** (`vitest run`). No `beforeAll`/hook timeouts were observed in any run.

Delta vs baseline: **+4 files**, **+23 tests** (409 → 432), in the four new
files `tests/reportModal.test.mjs` (15), `tests/storeSave.test.mjs` (5),
`tests/prohibitedReport.test.mjs` (2) and `tests/cardIdEscape.test.mjs` (1).

Per-step runs (all green):

| Step | Files | Tests | Duration |
|---|---|---|---|
| Baseline (`950995d`) | 26 | 409 | 25.93s |
| Step 1 | 27 | 424 | 26.11s |
| Step 2 | 28 | 429 | 29.44s |
| Step 3 | 29 | 431 | 34.23s |
| Step 5 (final) | 30 | 432 | 32.71s |

## 2. Fail-first evidence (E3)

Tests were written before each fix and observed to fail against the unmodified
source:

- **Step 1** — 5 of 15 `reportModal` tests failed: the demo-mode test (report
  button was rendered in demo mode), the tricky-id attribute test, the
  success-reset test, and both Escape tests (no keydown listener existed).
- **Step 2** — no source change; the 5 `storeSave` tests passed on the first
  run. Mutation proof: changing `'Retry'` to `'Retri'` inside `saveStoreEdit`
  failed the three Retry-related tests; `git checkout -- public/assets/js/app.js`
  restored the file byte-identically (`git diff --quiet` → IDENTICAL) and all
  5 passed again.
- **Step 3** — the `prohibitedReport` content test failed ("Until the in-page
  Report button" still present); the placeholder test passed.
- **Step 5** — the `cardIdEscape` test failed against the unmodified source
  (`expected 'a' to be 'a"b<c'` — the unescaped `data-id` truncated at the
  quote); after escaping it passed, and `reportModal` still passed 15/15.

## 3. Lint and whitespace

- `npm run lint` (`eslint .`) → clean (exit 0) before every commit; the
  pre-commit ESLint hook passed on every commit.
- `git diff --check main..phase-8-polish` → clean.
- Line endings: `public/legal/prohibited-items.html` remains CRLF; new files
  are LF.

## 4. Diff stat (`main..phase-8-polish`)

```
 docs/CHANGELOG.md                  |  61 ++++++
 docs/DECISIONS.md                  |  20 +++
 docs/LEGAL_FACTS.md                |   2 +-
 public/assets/js/app.js            |  26 ++-
 public/legal/prohibited-items.html |   2 +-
 tests/cardIdEscape.test.mjs        |  85 +++++
 tests/prohibitedReport.test.mjs    |  27 +++
 tests/reportModal.test.mjs         | 328 +++++++++++++++++++++++++++++++++++++
 tests/storeSave.test.mjs           | 204 +++++++++++++++++++++++
 9 files changed, 755 insertions(+), 5 deletions(-)
```

## 5. Commits

```
709a4fa fix(ui): escape listing card data-id
ff1a9cb docs(legal): prohibited items page reflects the Report button
bdb8d2a test(ui): cover store save and retry states
e9aa834 fix(ui): harden report entry points and add tests
```
Four step commits on top of `main`, plus the earlier gate-report commit
(`d2f803d`) — five commits on top of `main` — and this updated report commit is
the sixth.

## 6. Scope checks

- `grep TEMPLATE` across every changed file → **no matches**.
- Existing tests changed: **none**. `git diff --name-status main..phase-8-polish
  -- tests/` lists only `A` (added) for the three new files.
- `git diff main..phase-8-polish -- src/` → **empty**.
- `git diff main..phase-8-polish -- scripts/` → **empty**.
- No new npm dependencies. No merge, no push.

## 7. Key code

Final Report button lines (`public/assets/js/app.js`):

```js
// line 744 (listing detail)
    ${usingDemoData ? '' : `<button class="btn btn-ghost btn-sm" data-action="report-listing" data-target-id="${escapeAttr(listing._id)}" style="margin-top:10px;">🚩 Report</button>`}

// line 2093 (store page)
          <button class="btn btn-ghost btn-sm" data-action="report-store" data-target-id="${escapeAttr(store._id)}" style="margin-top:16px;">🚩 Report this store</button>
```

The listing card id line (`public/assets/js/app.js:673`, Step 5):

```js
    <div class="listing-card" data-id="${escapeAttr(l._id)}">
```

The keydown listener (registered once, inside `setupActionDelegation`):

```js
  // Escape closes the topmost dismissible modal. The store modal is
  // deliberately excluded: closing it aborts a pending payment poll, which an
  // accidental keypress must not do.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const reportOverlay = document.getElementById('reportModalOverlay');
    if (reportOverlay && reportOverlay.classList.contains('open')) {
      closeReportModal();
      return;
    }
    const listingOverlay = document.getElementById('modalOverlay');
    if (listingOverlay && listingOverlay.classList.contains('open')) {
      closeModal();
    }
  });
```

The `handleReportSubmit` success branch:

```js
    setBtnBusy(btn, false);
    showToast('✅ Report submitted. Thank you.');
    closeReportModal();
    document.getElementById('report-reason').value = '';
    document.getElementById('report-details').value = '';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }
    if (btn) { btn.textContent = 'Submit Report'; btn.disabled = false; }
```

## 8. Test outcomes

- `tests/reportModal.test.mjs` — **15 passed** (report button rendering, tricky
  id, demo mode, click-to-open, validation, body keys, success reset, 404/429/400
  messages, Retry second POST, store flow, four Escape cases).
- `tests/storeSave.test.mjs` — **5 passed** (pending `Saving…`, success
  `Saved ✓` → `Save Changes` + close at 2000 ms, failure `Retry`, Retry second
  PUT with owner-token header, offline message).
- `tests/prohibitedReport.test.mjs` — **2 passed** (new paragraph present / old
  sentence absent; placeholders within the five allowed).
- `tests/cardIdEscape.test.mjs` — **1 passed** (a hostile id round-trips through
  `dataset.id` with only `class` and `data-id` on the card).

## 9. Confirmation lines

- (a) No pattern text was added — Phase 8 did not touch `moderationService` (the
  Step 2 work is tests only, and `src/` is unchanged).
- (b) The store modal and payment-flow code are unchanged: the diff to
  `public/assets/js/app.js` is limited to the two report-button lines, the
  `handleReportSubmit` success branch, the new keydown listener, and the
  `listingCardHTML` `data-id` escaping.
- (c) No connection string, secret or phone number appears in any added file;
  fixtures use obvious placeholders (`test-phone`, `test-wa`, `store-owner-token-abc`).

## 10. UNVERIFIED items

- **Real browser upload behavior** — not exercised; the report tests drive the
  DOM through jsdom, not a real browser.
- **Real moderation traffic** — not applicable to Phase 8 (no moderation code
  changed); no live traffic was observed.
- **Real store/PUT round-trip against MongoDB** — not exercised; `fetch` is
  stubbed in the harness.
