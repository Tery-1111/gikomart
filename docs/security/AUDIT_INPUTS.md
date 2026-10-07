# Security-Posture Inventory — AUDIT INPUTS

Read-only inventory gathered from the repository on 2026-09-29 (branch `main` @ `6e4e1d9`).
Facts only. Secret **values** are redacted throughout; only names and read-sites are given.
Markers: CONFIRMED (verified in repo) / ABSENT (verified not present) / UNVERIFIED (cannot
be determined from the repo).

> **Update 2026-10-06 (`main` @ `ad7d5cb`):** §1.3's upload-limit facts were refreshed for the
> `perf(upload)` change (3 MB / 1280px), and a new **§10 Upload security chain** documents the
> full current pipeline. Everything else in this file remains the **2026-09-29 snapshot @
> `6e4e1d9`**. **Flagged stale (not rewritten — re-audit before relying on them):**
> §1.1 CSP block (PostHog domains no longer in the config; `imgSrc` now includes
> `gikomart.goatcounter.com` — `server.js:36`; a Permissions-Policy header is now set —
> `server.js:43-46`); §1.2 “central error handler ABSENT” and “all 500s send `err.message`”
> (a NODE_ENV-gated `src/middleware/errorHandler.js` now exists, registered at `server.js:122`);
> §3.1 “`.env.example` ABSENT” (now tracked in git); §3.3 “backups not in `.gitignore`” (now
> present — `.gitignore:3,9`); §4.1 “Redaction? None” (key-based redaction now exists —
> `src/utils/redact.js`, wired in `src/config/logger.js`); §4.2 “Request IDs — ABSENT” (now
> exists — `src/middleware/requestId.js`, `X-Request-ID` header); §4.3 webhook-body logging (now
> whitelists `invoice_id`/`state`/`api_ref` only — `src/controllers/paymentController.js`); §5.3
> “no dedicated admin limiter” (`adminLimiter` 10/min/IP now gates all three `/api/admin`
> routers); §7.2 retention (app-level PII stripping jobs now exist — `cleanupService.js`,
> 30/90-day windows); §8.1 CI (gitleaks secret-scanning and `npm audit --audit-level=high` jobs
> now present).

---

## SECTION 1: HTTP hardening

### 1.1 Helmet — CONFIRMED

- `package.json:32` → `"helmet": "^8.3.0"` (in `dependencies`).
- `server.js:5` → `const helmet = require('helmet');`
- `server.js:15` → `app.use(helmet({ ... }))` — first middleware.

Exact config block (`server.js:15-27`):

```js
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "gc.zgo.at", "us.i.posthog.com", "us-assets.i.posthog.com", "eu.i.posthog.com", "eu-assets.i.posthog.com", "'sha256-rqVYfj8ffdtUcz9D4+PFMNRtvPCPi1wPxdcs0/GnAw0='"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "https://gikomart.goatcounter.com", "https://us.i.posthog.com", "https://eu.i.posthog.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
```

Header-by-header:
- **CSP** — explicitly configured (above). Note: `styleSrc` includes `'unsafe-inline'`; third-party analytics hosts (goatcounter, PostHog) are allowed in `scriptSrc`/`connectSrc`. CONFIRMED.
- **HSTS** — not explicitly configured; provided by helmet's defaults (max-age 15552000; includes subdomains+preload in helmet ≥7 defaults). Not overridden anywhere. CONFIRMED (default).
- **X-Content-Type-Options** — not explicitly configured; helmet default `nosniff`. CONFIRMED (default).
- **Referrer-Policy** — not explicitly configured; helmet default (`no-referrer` in helmet ≥7). CONFIRMED (default).
- **Permissions-Policy** — ABSENT from config and not part of helmet's default set. No `permissionsPolicy` key anywhere. CONFIRMED ABSENT.
- **crossOriginEmbedderPolicy** — explicitly disabled (`server.js:27` → `crossOriginEmbedderPolicy: false`). CONFIRMED.

### 1.2 Error handling / information disclosure

- **Central Express error handler: ABSENT.** Command run: `grep -rn "app.use((err" server.js src/` → 0 hits. No terminal `app.use((err, req, res, next))` exists in the codebase.
- **NODE_ENV-gated disclosure: NO.** All 500 responses send `err.message` unconditionally. Decision line example — `src/controllers/listingController.js:109`:
  ```js
  res.status(500).json({ success: false, error: err.message });
  ```
  No `if (process.env.NODE_ENV === 'production')` branch exists in any controller. (`NODE_ENV` is read only in `src/config/logger.js:13,52` for log formatting.) UNVERIFIED whether stack traces ever reach clients — none are placed in response bodies anywhere (`grep` for `err.stack` in `src/controllers/` → ABSENT), but raw `err.message` from mongoose/IntaSend internals is exposed on every 500.
- **All `res.status(500)` sites (21)** — every body has the shape `{ success: false, error: <string> }`:
  | Site | Body content |
  |---|---|
  | `adminAuthController.js:80,118,176` | static strings ('2FA setup failed' / '2FA verification failed' / 'Login failed') — no detail leaked |
  | `listingController.js:109,124,164,195,217` | `err.message` RAW |
  | `paymentController.js:52,149,243` | `errMsg` = `err.message \|\| err.response?.data?.detail \|\| JSON.stringify(err.response?.data)` RAW (`paymentController.js:15`) |
  | `paymentController.js:405,428` | `err.message` RAW |
  | `storeController.js:62,89,104,142,204,261,301` | `err.message` RAW |
  | `termsController.js:75` | `err.message` RAW |
- **`console.error(` in `src/` + `server.js`: ABSENT** (0 hits). Two hits exist in `scripts/backup.js:27,39` (CLI script, not request path).

### 1.3 Request size limits

| Parser | Site | Limit |
|---|---|---|
| `express.json` | `server.js:53` | `'1mb'` — CONFIRMED |
| `express.urlencoded` | — | ABSENT (no call anywhere) |
| `express.raw` | — | ABSENT |
| `multer` | `src/routes/upload.js:8-12` | `limits: { fileSize: 3 * 1024 * 1024, files: 1 }` (memoryStorage) — CONFIRMED (2026-10-06; was 5 MB before `ad7d5cb`) |

Routes accepting bodies: all `/api/listings` PUT, all `/api/payments` POST, all `/api/stores` PUT, `/api/terms/contact-acceptance` POST, `/api/admin/*` POST, `/api/upload` POST. All JSON bodies fall under the single global 1 MB `express.json`; the upload route’s multipart body is capped by multer’s 3 MB (2026-10-06; was 5 MB before `ad7d5cb`). CONFIRMED.

---

## SECTION 2: SSRF surface

### 2.1 Outbound HTTP from the server — CONFIRMED (2 sites, neither fetches a user URL server-side)

Command run: `grep -rn "fetch(\|axios\.get\|axios\.post\|axios(\|https\.get\|http\.get\|got(\|node-fetch\|superagent\|undici" src/` → 2 hits:

| Site | Line | URL argument | Classification |
|---|---|---|---|
| `src/services/whatsappService.js:31` | `axios.post(\`${WHAPI_URL}/messages/image\`, { to: groupId, media: imageUrl, ... })` | `WHAPI_URL` = hardcoded `'https://gate.whapi.cloud'` (`whatsappService.js:4`); `imageUrl` = listing's Cloudinary URL | (a) hardcoded base + (c) a user-influenced **string** (`imageUrl` from listing data) is *passed as payload* to WhAPI — WhAPI fetches it, not this server |
| `src/services/whatsappService.js:37` | `axios.post(\`${WHAPI_URL}/messages/text\`, { to: groupId, body: message }, ...)` | hardcoded base; `groupId` from `WHATSAPP_GROUPS` env | (a)/(b) |

Additional outbound callers (via SDKs, not direct HTTP calls): `intasend-node` SDK (`paymentService.js:8-11`, hardcoded IntaSend API), Cloudinary SDK (`config/cloudinary.js:5-7`, configured hosts).

Explicit feature check: image-from-URL **ABSENT**, import-from-URL **ABSENT**, webhook config endpoints **ABSENT**, link preview **ABSENT**, avatar fetch **ABSENT**, screenshot services **ABSENT**, RSS/feed fetch **ABSENT**. (Commands: greps above plus the absence of any route accepting a URL parameter — no route file contains a `url` body field being dereferenced into an HTTP call.)

### 2.2 Redirect/DNS handling on user-controlled URL fetches

**N/A — conditional section skipped.** No server-side fetch of a user-controlled URL exists (2.1). For completeness: `axios.post` calls have no `maxRedirects`/`protocol`/IP-validation options set — but no user URL is dereferenced server-side, so there is no SSRF dereference path. CONFIRMED.

---

## SECTION 3: Database and infrastructure

### 3.1 Mongo deployment — Atlas (per repo evidence), CONFIRMED / UNVERIFIED mix

- `server.js:89` → `mongoose.connect(process.env.MONGO_URI)` — URI is env-only; **no construction in code**, no default fallback. (If unset, connect fails — no hardcoded URI in `server.js`.)
- Atlas evidence in-repo: `scripts/backup.js:12-13` comment — "`mongodb+srv://` connection string … Atlas free-tier instances support mongodump directly." CONFIRMED (comment-level).
- `.env.example`: **ABSENT** — file does not exist and has no git history (`git log --all -- .env.example` → empty). Deployment shape therefore comes only from `backup.js` comments and the live `.env` (gitignored, not inspected for values; the scheme observed in the working `.env` during this session is `mongodb+srv` → Atlas, db `gikomart`).
- Connection-string shape: `srv://` (SRV, Atlas-style) per backup.js comment + working env. No `host:port` direct or replica-set options in code. CONFIRMED (srv).
- **UNVERIFIED: Atlas IP allowlist scope** (0.0.0.0/0 vs scoped) — dashboard check, cannot be determined from repo.

### 3.2 Encryption at rest / TLS to DB

- No `tls=true` / `ssl=true` / `tlsCAFile` / `sslCA` options anywhere in code (grep for `tls|ssl|encrypt` in `src/` + `server.js` → only the SDK-internal Cloudinary usage). CONFIRMED ABSENT as explicit options.
- Fact: `mongodb+srv://` scheme implies TLS by default in the MongoDB driver; if the deployment URI is srv, transport TLS is on by driver default. App-layer field encryption: ABSENT (`grep -rn "cipher\|aes-256\|encrypt(" src/` → 0 hits).

### 3.3 Backups

- `scripts/backup.js` — CONFIRMED. Runs `mongodump --uri <MONGO_URI> --out backups/<timestamp>` (`backup.js:37`), writes to local `backups/` dir (`:22`), requires `MONGO_URI` (`:25-29`). Purpose comment: "Intended to be invoked by a scheduled job (Render cron, GitHub Actions, or Windows Task Scheduler)" (`:6-7`).
- **Scheduler: ABSENT in-repo.** No CI job, cron file, or workflow invokes `backup.js` (`ci.yml` contains no backup step; no crontab in repo). UNVERIFIED whether a Render cron is configured externally.
- Docs on restore/RPO/RTO/snapshot: **ABSENT** — `docs/` contains only `ui-audit/` (`audit-report.md`, `design-system.md`); **`README.md` does not exist**; greps for `restore|RPO|RTO|snapshot` across `docs/` → 0 hits.
- `backups/` and `logs/` are not tracked by git (`git ls-files backups/ logs/` → empty) but `backups` is **not in `.gitignore`** (grep → ABSENT) — risk of accidental future commit of dumps. CONFIRMED (fact, no recommendation).

---

## SECTION 4: Logging

### 4.1 Logger — CONFIRMED

File: `src/config/logger.js` (winston). Config block (`logger.js:14-53`, abridged exactly as written):

```js
const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',            // isProduction = NODE_ENV === 'production' (:13)
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isProduction ? winston.format.json() : winston.format.printf(...readable...),
  ),
  transports: [
    new winston.transports.File({ dirname: logDir, filename: 'error.log',  level: 'error', maxsize: 5*1024*1024, maxFiles: 5, tailable: true }),
    new winston.transports.File({ dirname: logDir, filename: 'combined.log', maxsize: 5*1024*1024, maxFiles: 5, tailable: true }),
  ],
  exceptionHandlers: [ new winston.transports.File({ dirname: logDir, filename: 'exceptions.log' }) ],
});
if (process.env.NODE_ENV !== 'test') {
  logger.add(new winston.transports.Console({ format: isProduction ? winston.format.simple() : ... }));
}
```

Answers:
- **JSON or plain text?** JSON in production (file transports), colored printf in development; the *console* transport uses `format.simple()` in production (`logger.js:55-57`) — i.e. stdout in production is simple text, not JSON. Fact as written.
- **Level filtering?** `info` in production, `debug` otherwise; file transport `error.log` capped at `error`.
- **Transports?** `logs/error.log` (5 MB × 5 rotated), `logs/combined.log` (5 MB × 5), `logs/exceptions.log` (unbounded), console when `NODE_ENV !== 'test'`.
- **Redaction?** None. No redaction format/transform exists.
- **Fields emitted:** `timestamp`, `level`, `message`, plus arbitrary meta object per call site (e.g. request log: `method, path, status, ms, ip, userAgent` — `server.js:66-72`; error sites: `error`).

### 4.2 Request IDs — ABSENT

Command: `grep -rn "requestId\|req\.id\b\|x-request-id\|uuid\|nanoid\|randomUUID" src/ server.js` → 0 hits. Nothing sets or propagates a request ID to logs or responses. CONFIRMED ABSENT.

### 4.3 Sensitive data in logs

Command: `grep -rn` across controllers/middleware/services/config for `req.body|req.headers|password|token|secret|authorization|cookie` intersected with `logger.|console.` → **1 hit**:

| Site | Snippet | Verdict |
|---|---|---|
| `src/controllers/paymentController.js:252` | `logger.error('Webhook challenge mismatch', { body: JSON.stringify(req.body) });` | **RAW** — logs the entire attacker-controlled webhook body (challenge mismatch path only; no redaction helper exists) |

Non-secret by-content logging (fact, no classification claim): request access log `server.js:66-72` records `ip` (from `x-forwarded-for` or socket) and `userAgent` per request; `path` is query-stripped. All other logger calls log `err.message` or static strings (grep-verified: no `logger.*` call includes `req.headers`, `password`, `authorization`, or `cookie`).

---

## SECTION 5: Admin surface

### 5.1 Every admin route — CONFIRMED

`src/routes/adminAuth.js` (mounted at `server.js:83` → `/api/admin`) and every route using admin auth elsewhere:

| METHOD | PATH | What it does | Auth layers |
|---|---|---|---|
| POST | `/api/admin/setup-2fa` | generate TOTP secret + QR, upsert Admin record | `adminKeyValid()` checked **inside controller** (`adminAuthController.js:25-34`); no route middleware |
| POST | `/api/admin/verify-2fa` | verify TOTP code, set `totpEnabled=true` | same — controller-level `adminKeyValid()` |
| POST | `/api/admin/login` | ADMIN_KEY + TOTP → signed 24h session token (`adminAuthController.js:130-150`) | same |
| PUT | `/api/listings/:id/moderate` | approve/flag/remove any listing | `adminAuth` route middleware (`listings.js:20`) → `authenticateAdmin` (`middleware/adminAuth.js:64-107`: 2FA session required once any admin has 2FA on; raw key accepted pre-2FA) |
| DELETE | `/api/stores/:id` | cascade-delete store + listings | `storeAuth({ allowAdmin: true })` (`stores.js:17`) → owner token **or** `authenticateAdmin` |

### 5.2 Max damage per admin credential — CONFIRMED

| Capability | Where | Max damage |
|---|---|---|
| Moderate listing | `listingController.js:245-262` | hide/show any listing (`moderationStatus` ∈ approved/flagged/removed) |
| Delete store (cascade) | `storeController.js:143-198` | hard-delete any store + all its listings (transactional) + Cloudinary images |
| Setup/verify/login | `adminAuthController.js:37-176` | mint a 24h admin session token; enable/reset 2FA on the single admin identity |
| Edit payment records | ABSENT — no endpoint touches Payment for admin | — |
| Read raw owner tokens | ABSENT — only sha256 hashes are stored (`Listing.js:31`, `Store.js:37`, `Payment.js:17`); raw tokens never persisted | — |
| Export data / PII dump | ABSENT — no export endpoint | — |
| Change roles / suspend users | ABSENT — no user/role model exists | — |
| Modify terms | ABSENT — `TERMS_VERSIONS` is a frozen code constant (`config/termsVersions.js:1-6`); terms routes are public read/record only | — |
| Run migrations | ABSENT — no migration runner | — |
| View PII | Partial — admin session can moderate/delete (which reads listings incl. seller phone numbers internally), but no listing-read endpoint exposes `sellerWhatsapp` by design (`listingController.js` list sanitization strips it; detail endpoint is public, not admin-gated) | — |

### 5.3 Exposure — CONFIRMED same app, no IP allowlist

- Mounted on the same Express app as public routes: `server.js:83` → `app.use('/api/admin', require('./src/routes/adminAuth'))`. CONFIRMED.
- IP allowlist: **ABSENT** (no such middleware exists).
- Rate limiting: global only — `app.use(globalLimiter)` (`server.js:50`; 100 req/min/IP, `rateLimiter.js:13-19`). No dedicated admin limiter (**ABSENT**). 2FA endpoints get the global limit only.
- Separate host: ABSENT — single Render service serves UI + API + admin.

---

## SECTION 6: Frontend / origin / CORS

### 6.1 Same-origin — CONFIRMED

- Static files: `server.js:77` → `app.use(express.static('public'))`.
- API: same app, `server.js:80-86` (`/api/listings`, `/api/upload`, `/api/payments`, `/api/admin`, `/api/stores`, `/api/terms`).
- Frontend calls: `public/assets/js/app.js:9` → `const API_BASE = '/api';` (relative, page origin).
**Verdict: SAME-ORIGIN.**

### 6.2 CORS config — CONFIRMED

Block (`server.js:34-48`):

```js
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://gikomart.onrender.com,http://localhost:5000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
}));
```

- Default allowed origins (all envs unless `CORS_ORIGINS` set): `https://gikomart.onrender.com`, `http://localhost:5000`. Env-overridable via comma-separated list.
- Origin-less requests (curl, mobile, same-origin GETs) are allowed (`!origin` branch).
- `credentials: true` — **ABSENT** (not set → cors default `false`). Interaction: since credentials are false, the allowlist governs ordinary CORS responses only; cookie-based credentialed cross-origin access is impossible by config (and the app has no cookie auth — token headers only).

---

## SECTION 7: PII and data

### 7.1 PII fields — CONFIRMED (all five models)

Encryption at app layer: **no** for every row (grep `cipher|aes-256|encrypt(` → ABSENT). "Hashed" = value stored only as sha256 by `termsAcceptanceService` (field names below).

| Model | Field | PII class | App-layer encrypted | Indexed |
|---|---|---|---|---|
| `Listing` (`Listing.js`) | `sellerName` :10 | name | no | no |
| | `sellerWhatsapp` :11 | phone | no | **yes** — `listingSchema.index({ sellerWhatsapp: 1 })` :37 |
| | `location` :12 | location | no | no |
| | `ownerTokenHash` :31 | credential hash | hashed (sha256 of raw token) | no; `select: false` |
| `Store` (`Store.js`) | `phone` :16, `whatsapp` :17 | phone | no | no |
| | `email` :18 | email | no | no |
| | `location` :22, `pickup_location` :23 | location | no | no |
| | `ownerTokenHash` :37 | credential hash | hashed | **yes** — unique index `Store.js:53`; `select: false` |
| `Payment` (`Payment.js`) | `phoneNumber` :8 | phone | no | no |
| | `listingData` :6 (Mixed) | embeds name/phone/location (sell-form payload) | no | no |
| | `storeData` :12 (Mixed) | embeds store contact PII | no | no |
| | `ownerTokenHash` :17 | credential hash | hashed | no |
| `TermsAcceptance` (`TermsAcceptance.js`) | `actor.phoneHash` :28, `actor.whatsappHash` :29, `sellerWhatsappHash` :56 | phone (hashed) | hashed | `:64-65` (actor hash indexes) |
| | `actor.ip` :31 | network identifier | no | no |
| | `actor.userAgent` :32 | device fingerprint-ish | no | no |
| | `actor.ownerTokenHash` :30 | credential hash | hashed | no |
| `Admin` (`Admin.js`) | `username` :14 | identifier | no | unique (schema `unique: true`) |
| | `totpSecret` :19 | credential | no (stored base32; `select: false`) | no |

### 7.2 Retention — CONFIRMED (app-level expiry; no TTL indexes)

- TTL (`expireAfterSeconds`) indexes: **ABSENT** (grep → 0 hits).
- App-level expiry fields: `Listing.expiresAt` (`Listing.js:22`, index `:38`), `Store.expires_at` (`Store.js:45`, index `:54`).
- Cleanup (`src/services/cleanupService.js`): `deleteExpiredListings` finds `{ expiresAt: { $lte: new Date() } }` (:17), destroys each listing's Cloudinary images (:22-32), then `Listing.deleteOne({ _id: ... })` (:38) — **deletes the entire listing document, including `sellerName`, `sellerWhatsapp`, `location`** (raw PII). Window = package duration at purchase: 24 h / 7 d / 30 d (`paymentService.js:19-23` LISTING_PRICES) — i.e. PII-bearing listings are hard-deleted ≤30 days after creation. `expireStores` (:44-59) only flips `status` to `'expired'` — **Store contact PII (phone/whatsapp/email) is retained indefinitely**; no store deletion job exists. `TermsAcceptance` records have no expiry — retained indefinitely (audit-log semantics). CONFIRMED.

---

## SECTION 8: CI and supply chain

### 8.1 ci.yml — CONFIRMED (full paste)

```yaml
# CI: lint + test on every push and pull request so error sweeps are automatic.
# (The release-triggered publish workflow lives in npm-publish-github-packages.yml.)
#
# The vitest suite mocks MongoDB, Cloudinary, IntaSend and WhatsApp, so no
# service containers are needed — npm ci && npm test is self-contained.
name: CI

on:
  push:
  pull_request:

# Superseded runs on the same branch are cancelled to save runner minutes.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test
```

Security-step inventory: secret scanning **ABSENT**; dependency scanning **ABSENT** in CI (an `npm audit --omit=dev` script exists at `package.json:12` but is not invoked by any workflow); SAST **partial** — `npm run lint` runs ESLint with `eslint-plugin-security` (devDependency, `package.json`) as the only code-scanning control; container scan **ABSENT** (no container build); license check **ABSENT**.

### 8.2 Lockfile — CONFIRMED

- `git ls-files package-lock.json` → `package-lock.json` (committed). CONFIRMED.
- CI installs with `npm ci` — `.github/workflows/ci.yml:29`. CONFIRMED.

### 8.3 Secrets hygiene

- `git log --all --oneline -- .env` → **empty** — `.env` was never committed. CONFIRMED.
- `.env.example` → file ABSENT, zero history.
- One secret-shaped artifact **was** committed historically: `totp-test.json` (contained key `totpCode`, value redacted here) committed in `8695095`, removed in `60000bd` ("chore: remove totp-test.json from version control"). The removed file remains recoverable from git history at `8695095:totp-test.json`. CONFIRMED.
- Env vars read by the app (names only; all values external):

| NAME | Read at | Purpose |
|---|---|---|
| `MONGO_URI` | `server.js:89`, `scripts/backup.js:25` | database connection |
| `ADMIN_KEY` | `middleware/adminAuth.js:84`, `controllers/adminAuthController.js:28` | legacy admin factor |
| `ADMIN_SESSION_SECRET` | `middleware/adminAuth.js:25` (module load) | HMAC for admin session tokens |
| `INTASEND_PUBLISHABLE_KEY` | `services/paymentService.js:5` (module load) | IntaSend client |
| `INTASEND_SECRET_KEY` | `services/paymentService.js:6` (module load) | IntaSend client |
| `INTASEND_TEST_MODE` | `services/paymentService.js:7` (module load) | sandbox toggle |
| `INTASEND_WEBHOOK_CHALLENGE` | `controllers/paymentController.js:251` | webhook auth |
| `WHAPI_TOKEN` | `services/whatsappService.js:3` (module load) | WhatsApp API bearer |
| `WHATSAPP_GROUPS` | `services/whatsappService.js:54` | broadcast targets (comma-separated) |
| `CORS_ORIGINS` | `server.js:35` | origin allowlist override |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | `config/cloudinary.js:5-7` (module load) | image CDN |
| `APP_URL` | `services/paymentService.js:48,66,90` | STK push host |
| `NODE_ENV` | `config/logger.js:13,52` | log formatting/level |
| `PORT` | `server.js:95` | listen port |

---

## SECTION 9: Secrets rotation and history

### 9.1 Were any secrets ever committed? — CONFIRMED: values never; one transient TOTP code yes

Commands: `git log --all -S "<NAME>" --oneline` per name. Results (commit lists = every commit whose diff mentions the name; spot-checks confirmed these are **code references** — variable reads, comments, fixture names — not committed values; the value-form probe `INTASEND_SECRET_KEY=` → **0 commits**; `mongodb+srv` appears only in `scripts/backup.js` comments at `8ac100a`):

| Probe | Commits touching the name |
|---|---|
| `INTASEND_SECRET_KEY` | `8e4196d`, `c61af42` (paymentService code) |
| `ADMIN_KEY` | `aa1d559`, `1cae74d`, `795c66d`, `8695095`, `8ac100a` |
| `ADMIN_SESSION_SECRET` | `aa1d559`, `8ac100a` |
| `INTASEND_WEBHOOK_CHALLENGE` | `aa1d559`, `1cae74d`, `e8c574c` |
| `WHAPI_TOKEN` | `8695095`, `f572328`, `8a073f4` (whatsappService code) |
| `MONGO_URI` | `8e4196d`, `8695095`, `8ac100a`, `8a073f4` |
| `totp-test.json` (artifact) | added `8695095` → removed `60000bd`; recoverable from history; contained a `totpCode` value (redacted) |

**Summary: no secret *values* for the six named vars were ever committed; one transient test TOTP code was (8695095, removed 60000bd).** Rotation/invalidation of that TOTP code: UNVERIFIED (it is time-based and expired by design within minutes; whether the associated secret was live in prod is a dashboard/process question).

### 9.2 Rotation evidence — ABSENT

Command: `grep -rin "rotat" README.md docs/` → **0 hits** (and `README.md` does not exist). No rotation policy, procedure, or runbook anywhere in the repo. CONFIRMED ABSENT.

---

---

## SECTION 10: Upload security chain — updated 2026-10-06/07 (`main` @ `6f72614`)

Endpoint: `POST /api/upload` (`src/routes/upload.js`). **Public (no auth) — re-affirmed as a
recorded decision on 2026-10-07 (`main` @ `6f72614`); see "Public-by-decision record" below.**
Layers in execution order:

| # | Control | Enforcement point | Value / behavior |
|---|---|---|---|
| 1 | Rate limit | `uploadLimiter` (`rateLimiter.js:23-29`), wired at `upload.js:44` | 10 requests/min/IP |
| 2 | Size limit | multer `limits.fileSize` (`upload.js:12`) | 3 MB max, single file; over-limit → 400 `"Image must be 3 MB or smaller"` (`upload.js:36-39`) |
| 3 | Field/quantity | `upload.single('image')` (`upload.js:44`) | exactly one file, field name `image` |
| 4 | Type validation | `fileTypeFromBuffer` magic-byte sniffing (`upload.js:51-53`) | allowlist `image/jpeg`, `image/png`, `image/webp`, `image/gif` only (`upload.js:25-30`); client-declared MIME is never trusted (not read anywhere in the path) |
| 5 | Concurrency | `createSemaphore(3, 10)` (`upload.js:20`, `utils/semaphore.js`) | 3 concurrent sharp decodes, 10 queued; overflow → 503 with `requestId` (`UPLOAD_BUSY`) |
| 6 | Decode cap | sharp `limitInputPixels: 25_000_000`, `animated: false` (`upload.js:79`) | rejects pixel-flood bombs > 25 MP before pixel allocation |
| 7 | Re-encode | `.rotate()` → `.resize(1280×1280, fit:'inside', withoutEnlargement:true)` → `.jpeg({quality: 80})` (`upload.js:81-83`) | every upload becomes a freshly encoded JPEG ≤1280px; EXIF/metadata stripped |
| 8 | Storage | multer `memoryStorage()` (`upload.js:9`) | no filesystem writes anywhere in the path; `originalname` is never read (no filename surface) |
| 9 | CDN intake | `cloudinary.uploader.upload` (`upload.js:97-103`) | `allowed_formats: ['jpg','jpeg','png','webp','gif']`, `resource_type: 'image'`, folder `gikomart`, `quality: 'auto'`, `fetch_format: 'auto'` |
| 10 | Delivery | CSP `imgSrc` (`server.js:36`) | `'self'`, `data:`, `https://res.cloudinary.com`, `https://gikomart.goatcounter.com` only |
| 11 | Orphan sweep | `destroyOrphanUploads` (`cleanupService.js:83-93`), 30-min scheduler; assets recorded at upload time (`upload.js`, `Upload.create`) | Cloudinary assets never attached to a listing/store are destroyed after 24h (batch of 100 per tick) |

**Defense in depth — why multiple layers exist:**
- **Magic bytes** (layer 4) prevent MIME spoofing: a request declaring `image/jpeg` with
  non-image bytes is rejected regardless of headers.
- **Sharp re-encode** (layer 7) destroys polyglot/steganographic payloads: whatever survives
  sniffing is decoded and re-encoded as a clean JPEG, so only pixel data reaches Cloudinary.
- **25 MP decode cap** (layer 6) prevents decompression bombs even when magic bytes pass: a tiny
  solid-colour PNG declaring huge dimensions is rejected before pixel allocation.
- **Memory storage** (layer 8) removes path-traversal and arbitrary-file-write surface entirely:
  nothing from the request ever touches the filesystem, and attacker-controlled filenames are
  never used.
- **Rate limit + semaphore** (layers 1, 5) prevent resource exhaustion: the per-IP request budget
  bounds upload frequency; the decode semaphore bounds concurrent memory-heavy processing and
  answers 503 (retryable) instead of queueing unboundedly.
- **Orphan sweep** (layer 11) bounds durable abuse: storage consumed by uploads that are never
  attached to a paid listing/store is reclaimed within ~24h, so anonymous callers cannot
  accumulate permanent CDN assets.

**Public-by-decision record (2026-10-07, `main` @ `6f72614`):**
- **Decision:** `POST /api/upload` intentionally requires **no authentication**. No auth
  middleware is to be added to the route under the current threat model.
- **Business requirement:** sellers upload images **before** any credential exists — the
  sell-form and Free Grant flows upload during listing creation, before an owner token
  (`X-Owner-Token`) or any session is issued. There is no seller-account/session mechanism in
  the codebase to gate on (grep for `authenticateUser|requireAuth|requireLogin|sellerAuth` in
  `src/middleware/` and `src/routes/` → only admin-side `verifySession` hits).
- **Existing controls (the accepted-risk bound):** per-IP rate limits (`uploadLimiter` 10/min
  + `uploadDailyLimiter` 100/24h), 3 MB multer cap, magic-byte allowlist, 25 MP decode cap,
  sharp re-encode to clean JPEG ≤1280px, memory-only storage, decode semaphore, Cloudinary
  `allowed_formats`, orphan sweep destroying never-attached assets after 24h.
- **Risk accepted:** Cloudinary storage abuse by anonymous callers (storage bandwidth/cost).
  Bounded per-IP by the rate limits above; residual multi-IP (distributed) volume remains the
  accepted exposure.
- **Future consideration:** if abuse is observed, the pre-analyzed options are (a) pre-issued
  upload tokens extending the existing owner-token pattern (`X-Owner-Token`, sha256 +
  timingSafeEqual), or (b) a seller-session mechanism. Either is an authentication-boundary
  change requiring its own review; the frontend caller (`app.js` `fetchUploadWithRetry`)
  currently sends no credential and would need a coordinated flow change.

---

## Open dashboard checks (cannot be determined from the repo)

1. **Atlas IP allowlist scope** — 0.0.0.0/0 vs scoped entries (Atlas → Network Access).
2. **Atlas encryption at rest / advanced settings** — repo proves only driver-default TLS via srv; at-rest encryption state is a dashboard fact.
3. **Render env values** — that the production values of all Section 8.3 vars are set, non-default, and that `INTASEND_TEST_MODE` is `false` in prod (STK pushes go to real money if `true`).
4. **IntaSend dashboard** — webhook URL registered (`/api/payments/webhook`), challenge secret there matches Render's `INTASEND_WEBHOOK_CHALLENGE`, enabled events, sandbox/live mode.
5. **Backup scheduling** — whether `scripts/backup.js` is actually invoked by any Render cron / Task Scheduler (in-repo evidence: not scheduled anywhere), where dumps land, and whether restore has ever been rehearsed (no RPO/RTO docs exist).
6. **WHAPI account** — group IDs validity and token scope (broadcast behavior with real groups UNVERIFIED).
7. **GoatCounter / PostHog** — whether the analytics hosts in CSP (`server.js:17,22`) are the tenant-correct endpoints.
8. **totp-test.json lineage** — whether the TOTP secret behind the committed test code (`8695095`) was ever a production secret (process question; the code itself expired by design).

## Dashboard check results — 2026-10-06 (`main` @ `2d37767`)

Results for Open dashboard checks 1, 3, 4, 5 (numbering above). Evidence classes:
E2 = repo source, E5 = live behavior of https://gikomart.onrender.com on 2026-10-06.
Dashboard-gated facts are marked as such; they were **not** observed and are not guessed.

### 1. Atlas IP allowlist — DASHBOARD-GATED, UNVERIFIED
- Repo evidence (E2): `mongoose.connect(process.env.MONGO_URI)` with no options (`server.js:128`);
  Atlas configuration is declared out-of-repo by Decision #29 (`docs/DECISIONS.md:346-353`).
- Live behavior (E5): no external evidence can distinguish 0.0.0.0/0 from scoped entries without
  a connection attempt using credentials this audit does not hold.
- **Status: NOT ESTABLISHED FROM AVAILABLE EVIDENCE.** Manual step (Atlas → Network Access):
  confirm 0.0.0.0/0 is absent and entries are scoped. Note the dependency: Render egress IPs are
  dynamic unless Static Outbound IPs is enabled (Render → Settings) — scope entries only after
  that exists, or the app loses DB connectivity.

### 3. Render env values — BEHAVIORALLY VERIFIED (E5), values dashboard-gated
- The serving process itself is evidence: `assertProductionSecrets()` runs before listen
  (`server.js:15`, `src/config/envGuard.js`) and exits on any absent/placeholder/<16-char value of
  `ADMIN_KEY`, `ADMIN_SESSION_SECRET`, `INTASEND_WEBHOOK_CHALLENGE`; `assertStartupConfig()`
  (`server.js:127`) exits if `MONGO_URI` is missing or `BLOCK_HASH_SECRET` is <16 chars in
  production. The service is up and healthy (`GET /health` → `{"status":"healthy"}`), therefore
  all five passed their guards at boot. **Inference from boot behavior, not a dashboard read.**
- Fail-closed proof (E5): `POST /api/payments/webhook` with no challenge → 401, with a wrong
  challenge → 401 (`{"success":false,"error":"Invalid webhook challenge"}`), i.e. the prod value
  of `INTASEND_WEBHOOK_CHALLENGE` is set and differs from probe values.
- CORS (E5): `Origin: https://evil.example` receives no `Access-Control-Allow-Origin`; the self
  origin is echoed — allowlist behavior confirmed without reading `CORS_ORIGINS`.
- **Still dashboard-gated (Render → Environment):** the actual values, and critically
  `INTASEND_TEST_MODE` — if `true`, STK pushes move real money. No code path or probe can
  distinguish test from live keys from outside.

### 4. IntaSend webhook config — BEHAVIORALLY VERIFIED (E5), registration dashboard-gated
- Guard verified live (E5): the challenge check (`src/controllers/paymentController.js:458-474`)
  rejects before any DB access and logs only `invoice_id`/`state`/`api_ref` (no body, no
  challenge value). Both probes above returned 401.
- Audit-trail note: the two probes produced two `Webhook challenge mismatch` error logs in prod
  (expected, benign, from this audit — not an intrusion signal).
- **Still dashboard-gated (IntaSend → Settings → Webhooks):** that the webhook URL is registered
  as `https://gikomart.onrender.com/api/payments/webhook`, that the challenge secret stored there
  equals Render’s `INTASEND_WEBHOOK_CHALLENGE` (this audit proved prod rejects non-matching
  values; only the dashboard can prove IntaSend sends the matching one), enabled events, and
  sandbox vs live mode.

### 5. Backup scheduling — NOT IMPLEMENTED IN REPO (by design), execution UNVERIFIED
- Repo evidence (E2): no scheduler references anywhere — zero "backup" occurrences in `src/`,
  no `schedule:`/`cron` in `.github/workflows/` (push/PR triggers only). `npm run backup`
  (`scripts/backup.js`, mongodump to gitignored `backups/<timestamp>/`) is manual-only by
  Decision #29; `docs/runbook-backup-restore.md` §5 says the scheduler lives in the host and
  §2 makes Atlas continuous backups an explicit Atlas-dashboard manual step.
- **Status: whether any Render cron / Task Scheduler actually invokes it: DASHBOARD-GATED,
  UNVERIFIED.** Restore drills: the runbook (§3-4) exists, but no evidence any drill was ever
  executed — record drills outside the database per §4.
- Operational trap for the dashboard step: Render instances (including cron jobs) have ephemeral
  disks — a dump written to `backups/` dies with the instance unless copied off-host. The
  runbook already requires this ("copy each dump somewhere safe … or it is not a backup"); any
  cron created must include that copy step, not just `npm run backup`.

### Summary

| # | Check | Result this date |
| - | ----- | ---------------- |
| 1 | Atlas IP allowlist | UNVERIFIED — dashboard-gated (Atlas → Network Access) |
| 3 | Render env values | Boot-guard pass + webhook/CORS behavior VERIFIED (E5); values and `INTASEND_TEST_MODE` still dashboard-gated |
| 4 | IntaSend webhook | Challenge guard VERIFIED fail-closed (E5); URL/secret-match registration dashboard-gated |
| 5 | Backup scheduling | NOT IMPLEMENTED in repo (by design, Decision #29); host-side execution UNVERIFIED — dashboard-gated |
