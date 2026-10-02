# Phase 6 — Exit Gate Report

Branch: `phase-6-legal` (from `phase-5b-reports` @ `e158bc1`)
Baseline: `e158bc1` — 20 test files / 322 tests passing.

## 1. Test suite

`npm test` → **22 test files passed (22) · 342 tests passed (342)**, duration
**65.49s** (`vitest run`).

Delta vs baseline: **+2 files** (`tests/legalPages.test.mjs`,
`tests/retentionAcceptanceAudit.test.mjs`) and **+20 tests** (322 → 342). New
tests: Step 1 +8 (`retentionAcceptanceAudit`), Step 4 +12 (`legalPages`). Both
new files were written first and observed to fail against the unmodified source
before the fix (see §4).

Per-step runs: Step 1 → 21 files / 330; Step 2 → 21 / 330; Step 3 → 21 / 330;
Step 4 → 22 / 342; Step 5 → 22 / 342. No hook timeouts were observed.

## 2. Lint and whitespace

- `npm run lint` (`eslint .`) → clean (exit 0, no output).
- `git diff --check phase-5b-reports..phase-6-legal` → clean (no whitespace
  errors, no line-ending inflation).

## 3. Diff stat (`phase-5b-reports..phase-6-legal`)

```
 .env.example                            |   2 +
 docs/API_AND_CONFIG.md                  |   3 +
 docs/CHANGELOG.md                       |  59 +++++++++
 docs/DECISIONS.md                       |  33 +++++
 docs/LEGAL_FACTS.md                     |  83 ++++++++++++
 docs/LEGAL_PLACEHOLDERS.md              |  19 +++
 docs/runbook-data-requests.md           | 146 +++++++++++++++++++++
 docs/runbook-moderation.md              |  38 ++++++
 public/index.html                       |   3 +
 public/legal/data-requests.html         |  70 ++++++++++
 public/legal/privacy-policy.html        | 187 +++++++++++++++++++++++++++
 public/legal/prohibited-items.html      |  72 ++++++++++++
 src/services/cleanupService.js          |  58 ++++++++-
 tests/legalPages.test.mjs               | 126 ++++++++++++++++++
 tests/retentionAcceptanceAudit.test.mjs | 220 ++++++++++++++++++++++++++++++++
 15 files changed, 1118 insertions(+), 1 deletion(-)
```

**Exactly one deleted line on the whole branch**: the
`cleanupService.js` `logger.info('Cleanup scheduler started …')` line, which was
rewritten to mention the new jobs. Every other change is an addition. No
line-ending inflation.

## 4. Commits

`git log --oneline phase-5b-reports..phase-6-legal` shows **exactly five feature
commits**, plus this report commit (the sixth):

```
b85798a docs: data request runbook
ce45f9e feat(legal): footer links, placeholder register and page tests
5ad0f06 docs(legal): prohibited items and data requests pages
3946a65 docs(legal): privacy policy page and fact sources
9ea500e feat(retention): strip old acceptance hashes and prune audit events
```

Fail-first evidence per step:

- **Step 1** — before the fix, all 8 `retentionAcceptanceAudit` tests failed with
  `stripOldAcceptanceHashes is not a function` / `pruneOldAuditEvents is not a
  function`. After the fix, the 3 retention files pass (16 tests).
- **Step 4** — before the footer links were added, `tests/legalPages.test.mjs`
  was 11 pass / 1 fail (the `public/index.html` href assertion). After adding the
  three links, all 12 pass.

Steps 2, 3 and 5 are documentation/content only and ship no new assertions.

## 5. `TEMPLATE` scan

`grep -in TEMPLATE` over every one of the 15 changed files → **0 matches in each
file**. No unresolved merge markers (`<<<<<<<` / `=======` / `>>>>>>>`) in any of
the 15 files either.

## 6. Existing tests changed = NONE

`git diff --numstat phase-5b-reports..phase-6-legal -- tests/`:

```
126     0       tests/legalPages.test.mjs
220     0       tests/retentionAcceptanceAudit.test.mjs
```

`tests/` gained two brand-new files and nothing else. **No existing test file
was modified, and no existing test line was changed.**

## 7. The four versioned legal pages and `termsVersions.js` are unchanged

```
git diff phase-5b-reports..HEAD -- public/legal/terms-of-service.html \
  public/legal/store-owner-terms.html public/legal/seller-terms.html \
  public/legal/buyer-terms.html src/config/termsVersions.js
```

→ **empty**. The versioned pages and the version registry are byte-for-byte
untouched. `tests/legalPages.test.mjs` additionally pins the LF-normalized
sha256 of the four existing pages, so any future edit to them fails the suite:

- `terms-of-service.html` `5555f97c9d148dbfe070b4447cc75ed22fffb213b3a103cdecf984a5da2bc55b`
- `store-owner-terms.html` `29820e0ea7596a45feb8cdb7a7e684591ec5266b27394729d8828c0f97731c82`
- `seller-terms.html` `ef08c02ea3d8770464845bb73abf0223ba4a7cad25cf60a5471515b04e42697e`
- `buyer-terms.html` `748931bb9fdf5490613c2a17026301e9edd6e95182c0337caeec08118298dd27`

## 8. Confirmations

**(a) The cron scheduler calls both new jobs.**
`src/services/cleanupService.js` lines 253–263:

```
  cron.schedule('*/30 * * * *', async () => {
    await deleteExpiredListings();
    await expireStores();
    await stripExpiredStoreContacts();
    await stripOldAcceptancePII();
    await stripOldAcceptanceHashes();      // ← new (line 259)
    await stripOldReportPII();
    await stripOldPaymentPII();
    await pruneOldAuditEvents();           // ← new (line 262)
  });
```

Both are also exported (`stripOldAcceptanceHashes` line 273,
`pruneOldAuditEvents` line 276).

**(b) No legal page contains a phone number, hash, IP address or secret.**
Scans over the three new pages (`privacy-policy.html`, `prohibited-items.html`,
`data-requests.html`):

| Check | privacy | prohibited | data-requests |
|---|---|---|---|
| `<script` | 0 | 0 | 0 |
| inline `on*=` handler | 0 | 0 | 0 |
| 64-hex run | 0 | 0 | 0 |
| 9+ digit run | 0 | 0 | 0 |
| `Cloudflare` | 0 | 0 | 0 |
| `<title>` + single `<h1>` | yes | yes | yes |

(The `on[a-z]+=` grep reports a single hit per page — that is `content=` inside
the `<meta name="viewport" content="width=device-width…">` tag, not an event
handler. Verified: no `onclick`/`onload`/etc. exists.) Each page carries a
`<title>` and headings; no page embeds credentials or personal data.

**(c) No existing `cleanupService` function was changed.**
`git diff phase-5b-reports..phase-6-legal -- src/services/cleanupService.js`
adding only: the `AuditEvent` require, the two new functions, the two cron calls,
the two exports, and one rewritten log line. The bodies of
`deleteExpiredListings` (L43), `expireStores` (L231), `stripExpiredStoreContacts`
(L74), `stripOldAcceptancePII` (L109), `stripOldReportPII` (L167) and
`stripOldPaymentPII` (L189) are untouched. The **only** removed line on the
branch is the scheduler-startup log string (§3).

## 9. Placeholder tokens

`grep -rEoh "\[[A-Z][A-Z_]+\]" public/legal/` → **exactly five distinct tokens**,
all documented in `docs/LEGAL_PLACEHOLDERS.md`:

```
[EFFECTIVE_DATE]
[OPERATOR_ADDRESS]
[OPERATOR_NAME]
[SUPPORT_EMAIL]
[SUPPORT_WHATSAPP]
```

All five must be replaced before launch.

## 10. Retention windows and their code anchors

| Data | Window | Function (line) |
|---|---|---|
| Expired listings (with images) | on expiry | `deleteExpiredListings` (L43) |
| Expired store contact PII | 30 days | `stripExpiredStoreContacts` (L74) |
| Acceptance actor IP / phoneHash / userAgent | 30 days | `stripOldAcceptancePII` (L109) |
| Acceptance `whatsappHash` + seller `sellerWhatsappHash` | 30 days | `stripOldAcceptanceHashes` (L138) |
| Report reporter IP | 30 days (`REPORT_IP_RETENTION_DAYS`, L13) | `stripOldReportPII` (L167) |
| Payment payer number + contact copies | 90 days (`PAYMENT_PII_RETENTION_DAYS`, L14) | `stripOldPaymentPII` (L189) |
| Audit events | 365 days default (`AUDIT_RETENTION_DAYS`, L218; `.env.example` L74) | `pruneOldAuditEvents` (L216) |

## 11. Third parties named in the privacy policy, and where each is proven

| Third party | Proving file / line |
|---|---|
| IntaSend | `src/services/paymentService.js:1` (`require('intasend-node')`), `package.json` |
| Cloudinary | `src/config/cloudinary.js:1` |
| Whapi.Cloud | `src/services/whatsappService.js:4` (`https://gate.whapi.cloud`) |
| Render | `server.js:55`; `.env.example:19,24` |
| MongoDB Atlas | `.env.example:26` (`MONGO_URI`) |
| Google Fonts | `public/index.html:7–9`; `server.js:34–35` (CSP `styleSrc`/`fontSrc`) |
| GoatCounter | `public/index.html:335`; `server.js:36–37` (CSP) |

Every name in the policy is backed by a real file. **PostHog is deliberately
absent**: it is not loaded in `public/index.html` nor allowed in the CSP, and
only appears in an untracked internal note (`docs/security/AUDIT_INPUTS.md`), so
it was not claimed as a third party.

## 12. Could not confirm

- **Nothing in the three new pages was left unsourced.** Each factual claim is
  traced in `docs/LEGAL_FACTS.md` (Claim | Source | Page).
- The Terms of Service is **not** silent on minimum age — it states 18+ at
  `public/legal/terms-of-service.html:43`, so the age sentence was included in
  the privacy policy. All other facts used were sourced.
- Session storage uses **localStorage only** — `public/assets/js/app.js` keys
  `gikomart_ownerToken:` (L16), `gikomart_pendingToken:` (L17),
  `gikomart_storeToken:` (L62). There are **no cookies** anywhere
  (`res.cookie`, `Set-Cookie` and `cookie-parser` are all absent), which is why
  the policy describes browser storage rather than cookies.
- `replayPayment` (`src/controllers/adminAuthController.js`) does **not** read
  `Payment.phoneNumber` or `listingData.sellerWhatsapp`; it delegates the whole
  record to `createResourceForPayment(payment)` — consistent with the "what we
  cannot erase" wording.

## 13. UNVERIFIED

- **Live MongoDB behavior.** The `deleteMany`/`find`/`updateMany` filters added
  here are exercised against hand-written fakes only. Real `$lte`/`$ne`/`$or`
  matching, `deleteMany` counts and nested `$unset` behavior are **NOT
  ESTABLISHED FROM AVAILABLE EVIDENCE**; the task forbids starting the server
  against a database.
- **Production startup.** The scheduler running inside a deployed Render
  instance (30-minute cadence, log output) is UNVERIFIED.
- **`req.ip` behind the proxy.** Report deduplication and IP retention depend on
  the real client IP under Render/Cloudflare (`TRUST_PROXY` unchanged), which is
  not exercised here.
- **External systems.** IntaSend, Whapi.Cloud, Cloudinary, Google Fonts and
  GoatCounter behavior is unchanged and out of scope; REQUIRES EXTERNAL
  VERIFICATION.

No network action was performed. Phase 7 is not started.
