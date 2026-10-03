# Phase 9 — 2FA setup guard — Exit Gate Report

Branch: `fix-2fa-setup-guard` (from `main` @ `950995d`)
Baseline: `main` @ `950995d` — 26 test files / 409 tests passing.
Task: re-apply the 2FA enrollment protection from `stash@{0}` to the current code.

## 1. Task contract

- **Objective:** make the 2FA setup write refuse to replace an already-enrolled
  factor, structurally (a database-level guard), not only via the application
  check.
- **In scope:** `setup2FA` in `src/controllers/adminAuthController.js`; a new
  test file; a CHANGELOG entry and a DECISIONS entry.
- **Out of scope:** any other source file; applying/popping/dropping the stash;
  merge or push; running the server against a database.
- **Forbidden changes:** `.github/workflows/ci.yml`, `docs/legal/`,
  `docs/security/`, `scripts/backup.js`, `.env`.

## 2. Pre-change findings (read-only, STEP 1)

- **(d1)** The current code already refuses to re-run setup for an enrolled admin
  when the TOTP code is missing (400 `TOTP code required`) or invalid (401
  `Invalid credentials`) — but a **valid** TOTP code still let setup proceed.
- **(d2)** The secret-storing `findOneAndUpdate` was **not** conditional on
  `totpEnabled`: the filter was `{ username: ADMIN_USERNAME }` with
  `upsert: true`, so an enrolled secret was overwritten unconditionally.

`d(2) = NO` → STEP 2 applied.

## 3. Change

`src/controllers/adminAuthController.js` only (9 lines changed):

- Filter changed from `{ username: ADMIN_USERNAME }` to
  `{ username: ADMIN_USERNAME, totpEnabled: { $ne: true } }`; the update
  document and `{ upsert: true }` option are unchanged.
- In the `catch`, before `logger.error`, added:
  `if (err.code === 11000) { return res.status(409).json({ success: false, error: '2FA is already enabled' }); }`
- The comment above the call replaced with the specified two-line comment.

The `Admin` model's only index is the implicit unique `username` index
(`src/models/Admin.js:18`); there is no explicit `schema.index()` call. The
unique index is what turns the excluded-filter upsert into a duplicate-key
error (`11000`).

## 4. Tests

New file `tests/setup2faGuard.test.mjs` (160 lines, 3 tests). It reuses the
`require.cache` injection harness from `tests/wiring.test.mjs` /
`tests/adminLockout.test.mjs` and injects a fake `Admin` model whose
`findOneAndUpdate` applies the query filter and throws an error with `code:
11000` when the filter excludes an existing document because `totpEnabled` is
`true` (emulating the unique index). No existing test file was edited.

Tests:

1. `setup-2fa` for a not-yet-enrolled admin returns 200 with `qrDataUrl` and
   `secret` and stores the secret.
2. `setup-2fa` for an enrolled admin with a valid TOTP code returns **409**
   `{ success:false, error:'2FA is already enabled' }` and does not change the
   stored secret.
3. The stored secret for an enrolled admin is byte-identical before and after
   the attempt.

**Fail-first evidence (E3):** against the unmodified source, tests 2 and 3
failed with `expected 200 to be 409` (the seed was overwritten); test 1 passed.
After the source change, all 3 pass.

```
tests/setup2faGuard.test.mjs (3 tests | 2 failed)   ← before the fix
  ✓ not-yet-enrolled admin returns 200 with qrDataUrl and secret
  × enrolled admin with a valid TOTP code returns 409
  × stored secret byte-identical before and after
```

## 5. Gate

- `npm test` → **27 test files passed (27) · 412 tests passed (412)**,
  duration **25.32s** (`vitest run`). No hook timeouts observed.
  Delta vs baseline: **+1 file** (`tests/setup2faGuard.test.mjs`),
  **+3 tests** (409 → 412).
- Targeted pre-commit runs: `tests/adminLockout.test.mjs` +
  `tests/auditTrail.test.mjs` + `tests/wiring.test.mjs` → 3 files / 198 tests
  passed (all existing admin/2FA tests unaffected).
- `npm run lint` (`eslint .`) → clean (exit 0). Pre-commit ESLint hook passed.
- `git diff --check main..HEAD` → clean.
- No existing test changed: `git diff --name-only main..HEAD -- tests/` lists
  only `tests/setup2faGuard.test.mjs`.
- `src` diff limited to `src/controllers/adminAuthController.js`.

## 6. Diff stat (`main..HEAD`)

```
 docs/CHANGELOG.md                      |  15 ++++
 docs/DECISIONS.md                      |  12 +++
 src/controllers/adminAuthController.js |   9 +-
 tests/setup2faGuard.test.mjs           | 160 +++++++++++++++++++++++++++++++++
 4 files changed, 193 insertions(+), 3 deletions(-)
```

## 7. Blast radius and reversibility

- **Directly affected:** the enrolled-admin branch of `POST /api/admin/setup-2fa`.
- **Indirectly affected:** none — the update document, response shape on the
  success path, and every other endpoint are unchanged.
- **Not affected:** first-time setup (no enrolled admin) still returns 200;
  `verify2FA`, `login`, moderation and session gating are untouched.
- **Reversibility:** R1 — a single `git revert` of the commit restores the prior
  behavior.

## 8. Commits

```
2baebf4 fix(admin): never replace an enrolled 2FA factor
```

The stash `stash@{0}` was **not** applied, popped, dropped, or modified.
No merge and no push were performed. The report below is the second commit
(`docs: 2FA setup guard gate report`).
