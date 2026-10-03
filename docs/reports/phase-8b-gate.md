# Phase 8b — Exit Gate Report

Branch: `phase-8b-hardening` (created from `phase-8-polish` @ `71fdaa5`).
Working tree at gate time: clean.

## Commits

Exactly four commits on top of `phase-8-polish`, in order:

| # | Commit | Message |
|---|--------|---------|
| 1 | `db6ebe0` | `fix(ui): keep the previous photo when a replacement upload fails` |
| 2 | `4ed2159` | `feat(moderation): match normalized and de-spaced text` |
| 3 | `3744d42` | `test(ops): backup script safety tests and restore runbook` |
| 4 | `2817b31` | `docs: lost authenticator recovery runbook` |

The report commit is the fifth.

## Tests

`npm test` → **33 test files / 449 tests passed**, duration 30.35s. No hook
timeouts (single run).

Per-step counts (each `npm test` run before that step's commit):

| State | Files | Tests | Delta |
|-------|-------|-------|-------|
| Baseline `phase-8-polish` | 30 | 432 | — |
| After Step 1 (`db6ebe0`) | 31 | 436 | +4 |
| After Step 2 (`4ed2159`) | 32 | 445 | +9 |
| After Step 3 (`3744d42`) | 33 | 449 | +4 |
| After Step 4 (`2817b31`) | 33 | 449 | +0 (docs only) |

Per-file new test counts (`npx vitest run tests/imageUploadRetention.test.mjs
tests/moderationEvasion.test.mjs tests/backupScript.test.mjs` → 3 files / 17
tests passed):

| File | Tests |
|------|-------|
| `tests/imageUploadRetention.test.mjs` | 4 |
| `tests/moderationEvasion.test.mjs` | 9 |
| `tests/backupScript.test.mjs` | 4 |
| **Total** | **17** |

## Lint and whitespace

- `npm run lint` → clean (`eslint .`, no output).
- `git diff --check phase-8-polish..HEAD` → clean (no whitespace errors).

## Diff stat

```
 docs/CHANGELOG.md                   |  53 +++++++++
 docs/DECISIONS.md                   |  37 +++++++
 docs/runbook-admin-portal.md        |  19 ++++
 docs/runbook-backup-restore.md      |  81 ++++++++++++++
 public/assets/js/app.js             |  27 +++--
 src/services/moderationService.js   |  50 +++++++--
 tests/backupScript.test.mjs         |  63 +++++++++++
 tests/imageUploadRetention.test.mjs | 210 ++++++++++++++++++++++++++++++++++++
 tests/moderationEvasion.test.mjs    | 100 +++++++++++++++++
 9 files changed, 627 insertions(+), 13 deletions(-)
```

## Scope checks

- `git diff --stat phase-8-polish..HEAD -- src/ scripts/` → only
  `src/services/moderationService.js` (43 insertions, 7 deletions). No
  `scripts/` change (Step 3's safety cases all passed on the unchanged script).
- `git diff --name-status phase-8-polish..HEAD -- tests/` → only additions:
  ```
  A	tests/backupScript.test.mjs
  A	tests/imageUploadRetention.test.mjs
  A	tests/moderationEvasion.test.mjs
  ```
  No existing test file modified.

## Reconciliation

Baseline 432 tests + 17 new tests = 449 tests, which equals the final total.

```
432 (baseline)
+ 4  (tests/imageUploadRetention.test.mjs)
+ 9  (tests/moderationEvasion.test.mjs)
+ 4  (tests/backupScript.test.mjs)
= 449  (final total)
```

File count: 30 (baseline) + 3 (new test files) = 33, which equals the final
total. **Match.**

## Confirmations

- (a) No pattern text was added: `git diff phase-8-polish..HEAD --
  src/services/moderationService.js` changes only `runPatterns` and adds the
  `normalizeText`, `despace` and `patternVariants` helpers; `FLAGGED_PATTERNS`
  and `SCAM_PATTERNS` are unchanged (verified by the source diff; no new pattern
  string appears in the diff).
- (b) The store modal and any payment flow code are unchanged: the only
  `src/` change is `src/services/moderationService.js`, and the only frontend
  change is inside `setupImageUpload` in `public/assets/js/app.js` (the store
  modal and `handleSubmit`/payment code are untouched).
- (c) No connection string, secret or phone number appears in any added file:
  `git grep -n -E "[0-9]{9,}"` on the two runbooks returns nothing; the only
  connection-string match is the deliberately fake fixture
  `mongodb://fake-user:fake-pass@localhost:1/fakedb` in
  `tests/backupScript.test.mjs`; the only "secret" match is the pre-existing
  variable name `BLOCK_HASH_SECRET` in `docs/runbook-admin-portal.md`; no
  `TEMPLATE` string appears in any changed file.

## UNVERIFIED

- **Real browser upload behaviour** — the retention tests run app.js under JSDOM
  with a stubbed `FileReader` and stubbed `fetch`; the real browser's timing of
  `FileReader` versus the upload response is not exercised here.
- **Real `mongodump` and `mongorestore`** — the backup tests run the script with
  `mongodump` absent (`PATH` empty) to prove it fails safely; no dump is taken
  and no restore is performed. `mongorestore` was never run.
- **Real moderation traffic** — the evasion tests call the service directly with
  synthetic strings; no live listing or store submission was screened.

## Stop

No merge performed. `phase-8b-hardening` is left in place for review.