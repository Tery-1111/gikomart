# Phase 7 — Exit Gate Report

Branch: `phase-7-admin` (from `phase-6-legal` @ `8daad7c`)
Baseline: `8daad7c` — 22 test files / 342 tests passing.

## 1. Test suite

`npm test` → **26 test files passed (26) · 409 tests passed (409)**, duration
**58.91s** (`vitest run`). No `beforeAll`/hook timeouts were observed in any run.

Delta vs baseline: **+4 files** (`tests/health.test.mjs`,
`tests/adminMetrics.test.mjs`, `tests/staticHeaders.test.mjs`,
`tests/adminPortal.test.mjs`) and **+67 tests** (342 → 409).

Per-step runs (all green, no hook timeouts):

| Step | Files | Tests | Duration |
|---|---|---|---|
| Baseline (`8daad7c`) | 22 | 342 | — |
| Step 1 | 23 | 349 | 51.76s |
| Step 2 | 24 | 358 | 52.17s |
| Step 3 | 26 | 382 | 65.86s |
| Step 4 | 26 | 396 | 58.26s |
| Step 5 | 26 | 409 | 57.26s |
| Final (this report) | 26 | 409 | 58.91s |

Fail-first evidence (tests written first, observed to fail against the
unmodified source, then pass):

- **Step 1** — 6/6 new tests failed with the original `health.js`
  (body mismatch and `getHealth is not a function`).
- **Step 2** — the metrics test file failed to load (`Cannot find module
  '../src/services/metricsService'`) and both wiring metrics tests failed (404).
- **Step 3** — `staticHeaders` failed to load (`staticOptions` missing) and all
  16 portal tests failed (admin page missing).
- **Step 4** — 14/14 new tests failed (Reports/Payments tabs absent).
- **Step 5** — 12/12 new tests failed (Blocks/Audit tabs absent).

## 2. Lint and whitespace

- `npm run lint` (`eslint .`) → clean (exit 0).
- `git diff --check phase-6-legal..phase-7-admin` → clean.

One trailing blank line at EOF in `public/assets/css/admin.css` was found by
`git diff --check` (introduced when the file was created in Step 3) and fixed by
amending the Step 3 commit; the branch history is still exactly five commits.

## 3. Diff stat (`phase-6-legal..phase-7-admin`)

```
 .env.example                       |   3 +-
 docs/API_AND_CONFIG.md             |  13 +-
 docs/CHANGELOG.md                  |  89 ++++
 docs/DECISIONS.md                  |  59 +++
 docs/runbook-admin-portal.md       |  86 ++++
 public/admin/index.html            |  43 ++
 public/assets/css/admin.css        | 133 ++++++
 public/assets/js/admin.js          | 825 +++++++++++++++++++++++++++++++++
 server.js                          |   9 +-
 src/config/staticOptions.js        |  18 +
 src/controllers/adminController.js |  54 +++
 src/routes/adminAuth.js            |   5 +-
 src/routes/health.js               |  27 +-
 src/services/metricsService.js     |  92 ++++
 tests/adminMetrics.test.mjs        | 214 +++++++++
 tests/adminPortal.test.mjs         | 920 +++++++++++++++++++++++++++++++++
 tests/health.test.mjs              | 139 ++++++
 tests/staticHeaders.test.mjs       | 101 ++++
 tests/wiring.test.mjs              |  35 ++
 19 files changed, 2831 insertions(+), 34 deletions(-)
```

No line-ending inflation.

## 4. Commits

`git log --oneline phase-6-legal..phase-7-admin` shows **exactly five** feature
commits (this report is the sixth):

```
b93fbbf feat(admin): blocks and audit tabs, portal docs
35352bb feat(admin): reports and payments tabs
98d4417 feat(admin): portal shell with sign-in, dashboard and health tabs
dbeae1d feat(admin): metrics endpoint
e9131ed feat(health): minimal public health and detailed admin health
```

## 5. `TEMPLATE` scan

`grep -ic TEMPLATE` over every file changed on the branch → **0** in all files
except `public/assets/css/admin.css`, where the single match is the CSS property
`grid-template-columns` (line 109), not a placeholder.

## 6. Existing tests and fakes changed

`git diff --numstat phase-6-legal..phase-7-admin -- tests/` shows every test
change is an addition (0 deletions):

```
214  0  tests/adminMetrics.test.mjs   (new)
920  0  tests/adminPortal.test.mjs    (new)
139  0  tests/health.test.mjs         (new)
101  0  tests/staticHeaders.test.mjs  (new)
35   0  tests/wiring.test.mjs
```

The only change to an existing test file is `tests/wiring.test.mjs` (+35 lines,
0 deletions), made of:

- **Authorization A** — fake-model additions only:
  - `countDocuments: async () => 0,` in the fake Store (line 295), fake Payment
    (line 332), fake BlockedContact (line 447) and fake Report (line 498) models.
  - `aggregate: async () => [],` in the fake Payment model (line 333).
- **Step 1** — a new `Admin health route` describe (1 test).
- **Step 2** — a new `Admin metrics route` describe (2 tests).

**Authorization B: no lines were needed** — no other existing fake broke because
of a new export.

No other existing test file was changed, and no existing assertion, expected
status or test name was modified.

## 7. Route check (`src/routes/adminAuth.js`)

`grep -c "^router\.\(get\|post\|put\|delete\)("` per commit:

```
baseline (phase-6-legal): 13
e9131ed (Step 1):         14   (+ /health)
dbeae1d (Step 2):         15   (+ /metrics)
98d4417 (Step 3):         15   (no route change)
35352bb (Step 4):         15   (no route change)
b93fbbf (Step 5):         15   (no route change)
```

## 8. `src/config/staticOptions.js` (full) and the `express.static` line

```js
// Options for express.static('public', ...). The admin portal and its assets are
// never cached and never indexed; everything else keeps the previous behavior
// (assets cached for a week, HTML revalidated on every load).
module.exports = {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    const isAdmin = /[\\/]public[\\/]admin[\\/]/.test(filePath)
      || /[\\/]assets[\\/](js|css)[\\/]admin\.(js|css)$/.test(filePath);
    if (isAdmin) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return;
    }
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0');
    }
  },
};
```

`server.js:105`:

```js
app.use(express.static('public', require('./src/config/staticOptions')));
```

## 9. `adminLimiter`

`src/middleware/rateLimiter.js:59-66`:

```js
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many admin requests — please try again later' },
});
```

Window **60 s**, max **10** per IP.

## 10. Forbidden constructs in `public/assets/js/admin.js`

```
$ grep -nE "innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval|new Function|localStorage|sessionStorage" public/assets/js/admin.js
(empty)
```

## 11. Public pages linking to admin

```
$ grep -rniE "href\s*=\s*[\"'][^\"']*admin" public/ --include=*.html
public/admin/index.html:9:<link rel="stylesheet" href="/assets/css/admin.css">
```

**TASK CONFLICT (reported, not worked around).** The literal command is not empty:
the only match is the admin portal's own stylesheet link, because the portal is
required to load `/assets/css/admin.css` (Step 3) and `staticOptions.js` keys the
no-store/noindex headers on exactly that filename. No *other* public page links
to admin:

```
$ grep -rniE "href\s*=\s*[\"'][^\"']*admin" public/index.html public/legal/ --include=*.html
(empty)
```

The same scoped check is asserted in `tests/staticHeaders.test.mjs`
(the exit-gate command cannot distinguish the portal's self-reference from a
public link).

## 12. Confirmations

- **(a)** `/health` returns only `{ status }` — `src/routes/health.js` responds
  `{ status: 'healthy' }` (200) / `{ status: 'unhealthy' }` (503); the only JSON
  key is `status`. Asserted in `tests/health.test.mjs`.
- **(b)** `/api/admin/metrics` and `/api/admin/health` require the admin session —
  both are registered with `requireAdminSession`
  (`src/routes/adminAuth.js`), which returns
  `401 { success:false, error:'Admin 2FA required' }` without a session.
  Asserted in `tests/wiring.test.mjs`.
- **(c)** No existing `emit()` call was changed and no new `emit()` call was added
  in Phase 7 — `git diff phase-6-legal..phase-7-admin | grep 'emit('` → no
  matches.
- **(d)** No phone number, hash, IP or secret appears in any file added: 0 ×
  64-hex strings and 0 × 9+ digit runs in every added source/page/test file.
  Test fixtures use obviously fake values (`0700000000`, `tok-abc`, `INV-1`,
  `id`s like `rep-1`).
- **(e)** `posthog` has **zero** matches in `public/index.html` (and anywhere under
  `public/`); `.env.example` was therefore changed — its Analytics comment now
  reads "No environment variables. The GoatCounter site code is hardcoded in
  public/index.html."

## 13. UNVERIFIED

- **Live MongoDB behavior.** The `countDocuments` filters and the
  `Payment.aggregate` pipeline are exercised against fake models only; real
  `$match`/`$group`/`$cond` behavior and counts are NOT ESTABLISHED FROM
  AVAILABLE EVIDENCE (no database is started).
- **Real browser rendering** of the portal. The portal is driven through a manual
  JSDOM instance, not a real browser.
- **Real login against a deployed server.** The portal's sign-in is exercised
  against a stubbed `fetch`; a real `POST /api/admin/login` with a TOTP code is
  REQUIRES EXTERNAL VERIFICATION.
- **The 5-second Cloudinary timeout path.** `getHealth`'s timeout is implemented
  but not exercised (tests use a resolving/rejecting ping, not a hung one).
- **Static headers behind the host.** Header behavior is verified against
  `express.static` locally; the effect of Render's/CDN's own caching in
  production is REQUIRES EXTERNAL VERIFICATION.
- **External systems** (IntaSend, Whapi.Cloud, Cloudinary, GoatCounter) are
  unchanged and out of scope.

No external action was performed. Phase 8 is not started.
