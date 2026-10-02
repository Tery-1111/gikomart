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
- **Health** — MongoDB and Cloudinary status, the check time and process uptime.
