# Admin Moderation Runbook

How to moderate listings and stores with the admin API. Every route, method,
header, body field, and action string below is read from the code, not guessed.

Set these once per shell session:

```bash
BASE_URL=https://your-deployment.example.com
ADMIN_KEY=…            # the ADMIN_KEY value from the server env
ADMIN_SESSION=…        # a session token from /api/admin/login (only once 2FA is on)
LISTING_ID=…           # the _id of the listing to act on
STORE_ID=…             # the _id of the store to act on
REPORT_ID=…            # the _id of the report to resolve
```

Admin routes live under `/api/admin` (mounted in `server.js` from
`src/routes/adminAuth.js`). The listing moderation route is under
`/api/listings` (`src/routes/listings.js`).

## 1. How admin authentication works today

There are two tiers, decided by whether an admin record has `totpEnabled: true`
(`src/middleware/adminAuth.js` → `authenticateAdmin`).

**Before 2FA is enrolled — key only.** Every admin request sends the raw admin
key in the `X-Admin-Key` header:

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"approved"}'
```

**After 2FA is enrolled — log in, then send the session.** With an enrolled
admin, the raw key alone is rejected (401 `Admin 2FA required`). Exchange the
key plus a current TOTP code for a session token:

```bash
ADMIN_SESSION=$(curl -sS -X POST "$BASE_URL/api/admin/login" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}' | jq -r '.token')
```

`POST /api/admin/login` returns `{"success":true,"token":"<hmac>"}`. Send that
token as the `X-Admin-Session` header on every admin request instead of the key:

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"approved"}'
```

To enroll in the first place: `POST /api/admin/setup-2fa` (header `X-Admin-Key`)
returns a secret/QR, then `POST /api/admin/verify-2fa` (header `X-Admin-Key`,
body `{"code":"<totp>"}`) enables it.

## 2. Approve a flagged listing

`PUT /api/listings/:id/moderate`, body action `approved`.

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"approved"}'
```

## 3. Flag a listing

`PUT /api/listings/:id/moderate`, body action `flagged`. A flagged listing is
hidden from public reads until it is approved or removed.

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"flagged"}'
```

## 4. Remove a listing

`PUT /api/listings/:id/moderate`, body action `removed`. Removed listings are
hidden from public reads and can no longer be edited by anyone.

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"removed"}'
```

## 5. Approve a flagged store

`PUT /api/admin/stores/:id/moderate`, body action `approved`. Approving a store
that was suspended by a removal also restores `status: active`.

```bash
curl -sS -X PUT "$BASE_URL/api/admin/stores/$STORE_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"approved"}'
```

## 6. Remove a store

`PUT /api/admin/stores/:id/moderate`, body action `removed`. This also sets
`status: suspended`, so the store drops out of public reads and its owner can no
longer edit it.

```bash
curl -sS -X PUT "$BASE_URL/api/admin/stores/$STORE_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"removed"}'
```

## 7. Suspend a store

`PUT /api/admin/stores/:id/suspend` (no body). Freezes the store for its owner
and hides it from public reads.

```bash
curl -sS -X PUT "$BASE_URL/api/admin/stores/$STORE_ID/suspend" \
  -H "X-Admin-Session: $ADMIN_SESSION"
```

## 8. Finding the id of a flagged item

No list endpoint exists; the id must come from the seller or the logs.

## 9. Block a seller number

`POST /api/admin/blocks`, header `X-Admin-Session`. `sourceType` is `phone`,
`listing` or `store`; for `listing`/`store` send `sourceId`, for `phone` send
`phone`. `reason` is required (1–200 characters). The response reports only
counts — never the number or its hash.

```bash
curl -sS -X POST "$BASE_URL/api/admin/blocks" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"phone","phone":"07XXXXXXXX","reason":"Repeated scam attempts"}'
```

## 10. List blocks

`GET /api/admin/blocks` returns the newest first (optional `?limit`, capped at
50). Each entry carries id, sourceType, sourceId, reason, createdBy and
createdAt — never the hash or the number.

```bash
curl -sS "$BASE_URL/api/admin/blocks?limit=50" \
  -H "X-Admin-Session: $ADMIN_SESSION"
```

## 11. Remove a block

`DELETE /api/admin/blocks/:id`.

```bash
curl -sS -X DELETE "$BASE_URL/api/admin/blocks/$BLOCK_ID" \
  -H "X-Admin-Session: $ADMIN_SESSION"
```

## 12. List open reports

`GET /api/admin/reports`, header `X-Admin-Session`. Returns open reports newest
first. Optional query: `status` is `open` (default), `actioned`, `dismissed` or
`all`; `targetType` is `listing` or `store`; `limit` is capped at 50. Each entry
carries id, targetType, targetId, reason, details, status, moderationAction,
resolvedAt, resolvedBy, note and createdAt — never the reporter IP.

```bash
curl -sS "$BASE_URL/api/admin/reports?status=open" \
  -H "X-Admin-Session: $ADMIN_SESSION"
```

## 13. Resolve a report after moderating

Resolving a report records the moderation action that was taken; it does not
change the listing or store. Moderate first, then resolve.

Step 1 — apply the moderation action (here, remove the listing):

```bash
curl -sS -X PUT "$BASE_URL/api/listings/$LISTING_ID/moderate" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"action":"removed"}'
```

Step 2 — close the report, recording that action:

```bash
curl -sS -X PUT "$BASE_URL/api/admin/reports/$REPORT_ID/resolve" \
  -H "X-Admin-Session: $ADMIN_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"resolution":"actioned","moderationAction":"removed"}'
```

`resolution` is `actioned` or `dismissed`. For `actioned`, `moderationAction` is
required and is one of `none`, `approved`, `flagged`, `removed`, `suspended`
(`suspended` is valid only for a store report). For `dismissed`, omit
`moderationAction` or send `none`. The optional `note` is at most 200 characters.
