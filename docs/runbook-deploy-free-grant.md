# Runbook — Deploying the Free Grant lifecycle changes

Ships the pending working-tree changes (lifecycle hardening, cross-device
continuation, admin mint, WhatsApp handoff, mint-volume alerting, docs) from
local `main` to production at `https://gikomart.onrender.com`. Written for this
specific shipment; the general static-cache behavior it relies on is documented
in `docs/API_AND_CONFIG.md` (§g) and `docs/CHANGELOG.md` (Phase 10c).

## What is being shipped

Sixteen files: backend (`src/controllers/grantController.js`, the new
`src/services/grantMintAlert.js`, `.env.example`), frontend
(`public/assets/js/app.js`, `public/index.html`), legal
(`public/legal/privacy-policy.html`), tests (`grantUx.test.mjs`,
`grantLifecycle.test.mjs`) and docs (CHANGELOG, API_AND_CONFIG, LEGAL_FACTS,
three runbooks — one new). Note that the lifecycle core, the admin mint and
the `?v=20261005a` cache-bust are **already live** (deployed 2026-10-05,
commits `14a90d8` + `3e17c08`); this shipment adds the WhatsApp handoff button,
the mint-volume alerting, and the docs sweep. The runbook still covers the
full verification surface so it doubles as a regression checklist.

## 0. Preconditions

- `git status` clean except the intended files; on `main`, in sync with
  `origin/main` before the new commits.
- Full gate green locally: `npm test` (expect 49 files, 599 tests, 1 skipped),
  `npx eslint .` silent, `git diff --check` empty.
- Confirm the cache-bust version in `public/index.html` is **newer than what
  production serves** (see step 3). Shipping changed JS without a bump is the
  Phase 10c incident all over again — stale `app.js` silently disables new UI.

## 1. Commit

Two commits, matching the repo's style (conventional subject, Codebuff footer):

1. **Code + tests** — `feat(grants): one-click WhatsApp handoff and mint-volume alerting`
   — `public/assets/js/app.js`, `public/index.html`,
   `src/controllers/grantController.js`, `src/services/grantMintAlert.js`,
   `.env.example`, `tests/grantUx.test.mjs`, `tests/grantLifecycle.test.mjs`.
2. **Docs** — `docs: grants runbook, deploy runbook and doc-consistency sweep`
   — everything under `docs/` and `public/legal/privacy-policy.html`.

The repo's pre-commit hook runs ESLint on staged files; let it pass.

## 2. Push and watch the deploy

`git push origin main`. Render auto-deploys `main`. Production is a free-tier
service: it cold-starts on demand and takes ~1–3 minutes from push to "new
build live" (the previous shipment was observable within ~40 seconds; allow
for spin-up). There is no manual approval step.

## 3. Confirm the NEW build is actually serving

The definitive marker is the versioned script tag — a cache key that only the
new build can serve:

```bash
curl -s https://gikomart.onrender.com/ | grep -o 'app.js?v=[0-9a-z]*'
# must print: app.js?v=20261005b   (the pending tree bumps 20261005a → b)
```

If it still shows `20261005a`, the deploy is not finished (or failed) — do not
proceed. While waiting, `/health` may return Render's cold-start page; retry
until `{"status":"healthy"}`.

Then check the cache headers that make the bump work:

```bash
curl -sI 'https://gikomart.onrender.com/assets/js/app.js?v=20261005b' | grep -i cache-control
# expect: Cache-Control: public, max-age=300
```

HTML stays `max-age=0`; the version bump is what guarantees every visitor
fetches the new JS immediately.

## 4. API surface verification (no credentials needed)

```bash
# New admin mint route must exist and refuse the public:
curl -s -X POST 'https://gikomart.onrender.com/api/admin/grants/<OBJECTID>/continuation-token' \
  -H 'Content-Type: application/json' -d '{}'
# expect: {"success":false,"error":"Admin session required"} [401]

# Redeem + status routes still gate correctly:
curl -s -X POST 'https://gikomart.onrender.com/api/grants/<OBJECTID>/redeem'
# expect: {"success":false,"error":"Grant token required"} [401]

# No regressions on the public read path:
curl -s -o /dev/null -w '%{http_code}' https://gikomart.onrender.com/api/listings
# expect: 200
```

## 5. Seller-side verification (browser)

1. Load `https://gikomart.onrender.com/` in a normal profile; confirm
   **Request a Free Grant** opens the modal (proves visitors got the new JS —
   the Phase 10c failure mode).
2. Submit a test grant (own test number). Expect the pending card with the
   **Copy WhatsApp message** button first in the action row.
3. Click it once: expect `Copied ✓` + "WhatsApp message copied" and, pasted
   anywhere, a message containing the request line, the number, and the
   `https://…/#grant=<id>/<token>` link. The token must NOT be visible as page
   text.
4. Continuation regression: clear the grant localStorage keys, then load a
   `#grant=<id>/<token>` URL — the address bar must lose the fragment
   immediately, the keys must reappear, and the pending card must reopen.

## 6. Admin-side verification (assisted sign-in)

The session is memory-only; someone with the admin key + TOTP signs in at
`/admin/` (never share the code with the operator driving the browser — sign
in yourself).

1. **Grant requests tab:** full numbers visible; filter pending → approved →
   rejected → provisioned all switch correctly.
2. On an approved, unprovisioned row: **New continuation link** (two-click) →
   row shows Open link / WhatsApp Seller / Copy link; token never visible as
   page text.
3. **Rotation:** from a terminal, status with the OLD token → 401; with the
   minted token → 200 `approved`.
4. **Alerting:** the volume alert fires only at `GRANT_MINT_ALERT_THRESHOLD`
   (default 5) mints in an hour — do NOT mint five times to test it. Verify
   wiring instead: the mint you just did emitted `admin.grant_continuation_minted`
   in the Audit log tab with no token material. (Volume behavior is covered by
   5 dedicated tests; production proof is a log watch.)
5. Leave test artifacts in a known state — reject nothing that is approved
   (approval is terminal); note the claim id in the ops log instead.

## 7. Rollback

`git revert` the two commits on `main` and push; Render redeploys in ~2
minutes. The revert restores `?v=20261005a`, and the 5-minute JS TTL means all
visitors self-heal within minutes. Database state needs NO rollback: the
shipment adds no collections and no migrations (GrantRequest predates it), and
minted credentials remain valid hashes of the same shape.

## 8. Environment variables

`GRANT_MINT_ALERT_THRESHOLD` is optional (default 5). Set it in the Render
dashboard only if you want a different sensitivity; the app reads it at call
time, so no restart ordering matters. Nothing else changed.
