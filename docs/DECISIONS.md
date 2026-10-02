# Architecture Decision Records

Numbered decisions taken during the security-hardening work. Each entry records
the decision, the reason, and an alternative that was rejected. New decisions get
new numbers; existing entries are never edited.

## 1. Trust proxy is a bounded hop count

- **Decision:** `app.set('trust proxy', N)` where `N` is `TRUST_PROXY` parsed as
  an integer, defaulting to **1**; never the boolean `true`. Set `TRUST_PROXY=2`
  when Cloudflare proxies in front of Render.
- **Reason:** A hop count makes `req.ip` the real client address for the known
  proxy chain. The boolean `true` trusts the entire `X-Forwarded-For` chain, so a
  client can spoof its own address and defeat per-IP rate limits and audit logs.
  `server.js` notes 1 covers Render alone and 2 is required once Cloudflare adds a
  hop.
- **Alternative rejected:** `app.set('trust proxy', true)`, which trusts every hop
  and lets a client forge its IP.

## 2. Production secrets need a minimum length; missing MONGO_URI fails fast

- **Decision:** In production, refuse to start when `ADMIN_KEY`,
  `ADMIN_SESSION_SECRET`, or `INTASEND_WEBHOOK_CHALLENGE` is absent, a documented
  placeholder (`changeme`/`undefined`/`''`), or shorter than **16 characters**
  (`MIN_SECRET_LENGTH`). Also refuse to start when `MONGO_URI` is missing or blank
  (every environment except test).
- **Reason:** Short secrets are brute-forcible; `ADMIN_SESSION_SECRET` has no safe
  fallback (sessions are HMAC'd with it), and an unset
  `INTASEND_WEBHOOK_CHALLENGE` would let a forged webhook that omits the challenge
  be accepted. The app cannot run without a database, so a missing `MONGO_URI`
  should stop it at startup rather than fail later. Development and test are
  exempt so `npm test` needs no real secrets.
- **Alternative rejected:** Only rejecting the documented placeholder values with
  no length rule, which would accept a trivially short key.

## 3. store_id is rejected at listing creation and forced null at completion

- **Decision:** `POST /api/payments/initiate-listing` rejects any `store_id` other
  than undefined/null/'' with 400 before any payment side effect, and
  `createResourceForPayment` forces `store_id: null` on the created listing.
- **Reason:** A listing is published standalone; attaching it to a store is a
  separate, owner-authorized step (`attach-listing`). Allowing `store_id` at
  creation let a payer attach a listing to an arbitrary store without the store
  owner's action.
- **Alternative rejected:** Allowing the client to pre-attach the listing and
  validating store ownership at payment time, which duplicates the attach flow and
  widens the payment-time trust surface.

## 4. Boost is owner-only

- **Decision:** `POST /api/payments/boost` requires a valid `X-Owner-Token` (or
  authenticated admin) verified against the listing's `ownerTokenHash`, and returns
  403 otherwise. The boost UI renders only for owners.
- **Reason:** A boost spends money and changes a listing's prominence; it must be
  controlled by the listing's owner, not any caller who knows a listing id.
- **Alternative rejected:** Leaving the endpoint open and relying on the client to
  hide the button, which does not stop a direct API call.

## 5. Seller contact is released only by the contact-acceptance endpoint

- **Decision:** `POST /api/terms/contact-acceptance` is the single release point
  for seller contact. It validates the acceptance token **before any lookup**,
  resolves only a live approved listing (`{ _id, status: 'active',
  moderationStatus: 'approved' }`), returns that listing's **stored**
  `sellerWhatsapp`, records a hash of it, sets `Cache-Control: no-store`, and is
  capped by a per-IP hourly limiter (default 40, `CONTACT_RELEASE_LIMIT`). The
  number supplied in the request body is ignored.
- **Reason:** The number must come from the server's stored record after a
  recorded acceptance, not from a client value; the cache header keeps it out of
  intermediary caches, and the hourly cap limits bulk extraction.
- **Alternative rejected:** Trusting a `sellerWhatsapp` in the request body, which
  lets a caller supply an arbitrary number and does not actually gate the stored
  contact.

## 6. Moderation never auto-approves

- **Decision:** On listing and store edits, the merged document is re-screened and
  set to `flagged` when it matches the blocklist; the code never sets
  `moderationStatus` to `approved`. Only an admin moderation action can clear a
  flag.
- **Reason:** An owner could otherwise publish clean content, then edit in
  prohibited content; auto-approving a clean edit would also silently clear a flag
  an admin set.
- **Alternative rejected:** Only screening at creation time, or letting a clean
  edit reset the status to `approved`.

## 7. Flagged stores are hidden from the public slug route but visible to their owner

- **Decision:** `GET /api/stores/slug/:slug` filters
  `moderationStatus: { $nin: ['flagged', 'removed'] }` (so a missing field stays
  visible), while `GET /api/stores/:id` and `GET /api/stores/me/all` remain
  owner-gated and return flagged stores to their owner.
- **Reason:** A flagged store should not be publicly browsable, but its owner must
  still be able to see and manage it.
- **Alternative rejected:** Hiding flagged stores everywhere, which would lock an
  owner out of a store that is only under review.

## 8. Webhook authorization is a shared-secret challenge (Accepted risk)

- **Decision:** The payment webhook is authorized by comparing the body's
  `challenge` field against `INTASEND_WEBHOOK_CHALLENGE` (fail-closed when the
  expected value is unset). It is **not** a payload signature and does not bind the
  payer's identity — completion is keyed by `invoice_id` alone.
- **Reason (Accepted risk):** The code confirms only the shared-challenge check.
  Any party who knows the shared secret can post a `COMPLETE` for an invoice, and
  the webhook does not verify who actually paid; the accepted risk is that this
  shared secret is the sole gate on payment completion.
- **Alternative rejected:** Relying on an absent challenge being accepted (the old
  behavior), which lets a forged webhook with no `challenge` field through; this
  was fixed by failing closed.

## 9. Hidden-store inventory returns empty, not 404

- **Decision:** Inventory of suspended, flagged or removed stores is hidden from
  `GET /api/listings?store_id`; malformed or unknown store ids return an empty
  list, not an error, so existence is not revealed.
- **Reason:** A store that is suspended, flagged or removed must not expose its
  inventory, and a caller must not be able to probe whether a store id exists by
  reading the status code or error shape.
- **Alternative rejected:** Returning 404 for a hidden or unknown store, which
  would reveal whether the store id exists.
