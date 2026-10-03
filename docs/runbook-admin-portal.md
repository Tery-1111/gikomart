# Runbook — Admin portal

The browser admin portal is a static page served at `/admin/`. It is not linked
from any public page and is excluded from search engines, but it is not security
by obscurity: access needs the admin key plus a valid TOTP code.

## Open the portal

Navigate to `/admin/` on the deployed site (for example
`https://gikomart.onrender.com/admin/`). The page is sent with
`Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

## Sign in

Enter the admin key (`ADMIN_KEY`) and the current 6-digit authenticator code.
The key and code are sent to `POST /api/admin/login`. 2FA must be enrolled
first — see `docs/runbook-moderation.md`. If 2FA is not enabled, sign-in fails
with "Check the code and that 2FA is set up."

## Sessions

A session lasts 24 hours. The token lives only in memory: reloading or closing
the tab signs the admin out, and nothing is written to browser storage. When a
request returns 401 the portal returns to the sign-in screen with "Session
expired. Sign in again."

## Rate limit

Every portal request is subject to the admin rate limiter: **10 requests per
60 seconds per IP** (`adminLimiter` in `src/middleware/rateLimiter.js`). A 429
means wait and try again; the portal shows "Too many requests. Wait a minute and
try again." with a Retry button.

## Tabs

- **Dashboard** — site totals: active/flagged listings, active/flagged/suspended
  stores, pending/completed-24h/failed-24h payments, revenue for 24h/7d/30d (and
  by type for 30 days), open reports and blocked contacts.
- **Reports** — open reports by default, filterable by status and target type.
- **Payments** — payments filterable by status and type, with masked phone
  numbers and a replay action for eligible payments.
- **Blocks** — add, list and remove blocked contacts.
- **Audit log** — read audit events, filterable by action and resource.
- **Health** — MongoDB and Cloudinary status, the check time and process uptime.

## Reports tab

Lists reports (newest first). Filter by status (`open` by default) and target
type. Each open report offers three or four moderation buttons (Approve, Flag,
Remove, and Suspend store for store targets) and a resolution recorder.

**Apply the moderation action first, then record the resolution.** The
moderation buttons are two-click: the first click changes the button to
"Confirm?" and the second click within 4 seconds sends the request. On success
the row shows `Applied: <action>` and the resolution selects are filled in.
Recording a resolution sends `actioned` with a moderation action, or
`dismissed` with none.

## Payments tab

Lists payments (newest first), filterable by status and type. Payer phone
numbers are masked (first 4 and last 2 digits); full numbers are obtained only
through the data-request runbook (`docs/runbook-data-requests.md`). The replay
action is two-click confirmed and is offered only for non-completed payments
that carry an invoice id.

## Blocks tab

Adds a block from a phone number, a listing id or a store id. The list shows
what was blocked and who added it; removal is two-click confirmed. The portal
never shows a typed phone number again after submit. Rotating
`BLOCK_HASH_SECRET` invalidates every existing block — see
`docs/runbook-moderation.md`.

## Audit log tab

Reads audit events (newest first, 50 at a time), optionally filtered by action
and resource. Each event's metadata is truncated to 200 characters. "Load older"
requests the next page using the last row's timestamp as `before`.

## Known limits

- No polling: views refresh only when opened, reloaded or acted on.
- Sessions last 24 hours and are memory-only.
- The admin rate limit applies to every portal request.
- The portal requires 2FA to be enrolled before sign-in works.

## Lost authenticator (recovery)

This applies once the 2FA setup guard is deployed.

Once 2FA is enrolled, the API refuses to replace the authenticator: `setup-2fa`
will not overwrite the enrolled factor. Recovery is therefore done in the
database, then re-enrolled from the API.

1. Take a backup first, so the change can be reversed — see
   `docs/runbook-backup-restore.md`.
2. In the Atlas Data Explorer, open the `admins` collection and delete only the
   document whose `username` equals `owner`.
3. Run `setup-2fa` again with only the admin key (with the enrolled document
   gone, first-time setup is key-only again), scan the new QR code, then run
   `verify-2fa` and sign in to the portal.
4. Change `ADMIN_KEY` in the host environment afterwards.

Do not delete any other document in this collection.
