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

## 10. Blocked contacts are stored only as a hash, and blocking never removes content

- **Decision:** Blocked contacts are stored only as sha256 of the normalized
  Kenyan number; the API never returns the hash or the number; blocking a target
  never removes its content automatically.
- **Reason:** A block list keyed by hashed numbers lets an operator stop a
  number without storing the raw PII, and keeps the number out of responses and
  logs. Blocking is a gate, not a deletion, so an operator reviews content
  separately with the moderation endpoints.
- **Alternative rejected:** Storing raw numbers, which would place contact PII in
  a new collection and expose it on every read of the block list.

## 11. Block enforcement runs only at payment initiation

- **Decision:** Block enforcement runs only when a payment is initiated (listing
  and store plan). A payment that was already pending before a block was added
  can still complete; remove the content with the moderation endpoints.
- **Reason:** Initiation is the single point where a new payment can be refused
  before any money moves; checking in the webhook would reject payments the buyer
  has already paid for, which is worse than letting an operator remove the
  content.
- **Alternative rejected:** Also enforcing in the webhook.

## 12. Blocked contacts are hashed with HMAC-SHA256 using BLOCK_HASH_SECRET

- **Decision:** `contactHash` returns HMAC-SHA256 of the normalized number keyed
  by `BLOCK_HASH_SECRET` (at least 16 characters; required in production, with a
  fixed development/test fallback) instead of a plain SHA-256. Changing the
  secret invalidates existing blocks.
- **Reason:** The Kenyan number space is small enough to brute-force an unkeyed
  hash, so a plain digest gives only weak pseudonymity; a keyed MAC makes the
  stored hashes useless to anyone who does not hold the secret.
- **Alternative rejected:** Plain SHA-256 of the normalized number.

## 13. Reports are deduplicated per IP and window; resolving records, it does not moderate

- **Decision:** A report is deduplicated per reporter IP, target and a rolling
  24-hour window while it is still open; the reporter IP is kept only for that
  deduplication and is erased after 30 days. Resolving a report records the
  moderation action the admin took but does not perform it; the admin applies
  moderation through the moderation endpoints first.
- **Reason:** Deduplication stops one client from flooding the queue with repeats
  of the same complaint, and erasing the IP keeps the report from becoming a
  lasting record of who reported what. Recording the action instead of applying it
  keeps a single, authorized place (the moderation endpoints) that changes a
  listing or store, so a report cannot silently alter content.
- **Alternative rejected:** Having resolve apply the moderation itself, which
  would duplicate the moderation authority and let the report path mutate
  content.

## 14. Audit events record field names and ids, never values, contact data or hashes

- **Decision:** Audit events record field NAMES, resource and target ids, and
  small scalar counts/flags — never the edited values, contact numbers, contact
  hashes, tokens or reporter IPs.
- **Reason:** The audit log is readable by every session admin and is retained
  long-term, so anything written there is effectively a second copy of the
  underlying PII. Names and ids are enough to reconstruct what changed and who
  did it without turning the log into a contact-data store.
- **Alternative rejected:** Logging the edited field values (or a diff), which
  would copy listing/store contact data and free text into the audit collection.

## 15. Report IPs last 30 days; payment PII lasts 90 days and only for settled payments

- **Decision:** Report IPs are erased after 30 days. Payment phone numbers and
  the seller and store contact copies inside a payment payload are erased 90 days
  after creation for completed and failed payments, which is the dispute window;
  pending payments are never stripped.
- **Reason:** The report IP exists only to deduplicate repeats, so it has no
  value once the report is old. Payment contact data is needed while a dispute is
  plausible, but keeping it forever means a permanent contact store; pending
  payments are excluded because the payload is still needed to complete them.
- **Alternative rejected:** Keeping payment data indefinitely.

## 16. Acceptance records lose the WhatsApp hashes after 30 days, like phoneHash

- **Decision:** After 30 days, `stripOldAcceptanceHashes` nulls
  `actor.whatsappHash` and `sellerContactTarget.sellerWhatsappHash` on
  `TermsAcceptance` records, just as `phoneHash` is nulled. `ownerTokenHash`,
  listing and store ids and metadata are kept as evidence.
- **Reason:** These are unkeyed hashes of phone numbers and can be brute-forced
  over the Kenyan number space. The token hash derives from a long random value
  and cannot be reversed into a person, so it can stay.
- **Alternative rejected:** Keeping all hashes indefinitely.

## 17. Audit events are pruned after 365 days by a scheduled job

- **Decision:** Audit events are deleted after 365 days by a scheduled job,
  configurable with `AUDIT_RETENTION_DAYS` (a TTL index was rejected because the
  `timestamp` field already has a non-TTL index, which would conflict).
- **Reason:** The audit trail is an operational record, not a permanent archive;
  a bounded window keeps the collection small while still covering the period
  during which a dispute is likely.
- **Alternative rejected:** Keeping audit events forever.

## 18. Rotating BLOCK_HASH_SECRET invalidates every existing block

- **Decision:** Rotating `BLOCK_HASH_SECRET` invalidates every existing block.
  No rotation tool is built. Blocks created from a listing or store can be
  recreated from their stored `sourceId`; blocks created from a raw number need
  that number again, so keep a private record of blocked numbers.
- **Reason:** The blocked-contact list is keyed only by the HMAC hash, so a new
  secret produces different hashes and the old entries no longer match any
  incoming number. A dual-secret rotation window was judged not worth the added
  verification path for a single-operator deployment.
- **Alternative rejected:** A dual-secret rotation window.

## 19. The public /health endpoint returns only `{ status }`; details are admin-only

- **Decision:** The public `/health` endpoint reports only whether MongoDB is up
  and returns only `{ status: 'healthy' }` (200) or `{ status: 'unhealthy' }`
  (503). Detailed health, including the Cloudinary check with a 5-second timeout,
  is behind the admin session at `GET /api/admin/health`.
- **Reason:** Uptime monitors only need a pass/fail signal, so keeping the public
  body to a single field means dependency details (which providers are reachable)
  are not exposed publicly, and a Cloudinary blip cannot flap the monitor. The
  detailed view stays available to operators and needs no database query.
- **Alternative rejected:** Locking `/health` behind admin auth, which would
  break uptime monitors.

## 20. Admin metrics are counts and sums only

- **Decision:** Admin metrics (`GET /api/admin/metrics`) are counts and sums of
  `Payment.amount` for completed payments, grouped by `createdAt` windows of 24
  hours, 7 days and 30 days, and labelled `KSh`. Listing and store counts use the
  same visibility rules as the public site (e.g. active listings are `active`,
  `approved` and not expired).
- **Reason:** The metrics contain no personal data. The `Payment` schema has no
  currency field and the site prices are in KSh, so `KSh` is a label, not a
  stored value. Reusing the public visibility rules keeps the counts consistent
  with what shoppers actually see.
- **Alternative rejected:** Caching metric results, which is not needed at this
  size.

## 21. The admin portal is a static page with no robots.txt

- **Decision:** The admin portal is a static page at `/admin/` with all of its
  code in an external script, because the site CSP forbids inline scripts. It is
  not linked from any public page and is excluded from search engines with a
  response header and a meta tag. No `robots.txt` is used.
- **Reason:** A hidden URL is not security: protection is the admin key, the TOTP
  code and the signed session. A `robots.txt` disallow line would advertise the
  path to anyone who reads it.
- **Alternative rejected:** A `robots.txt` `Disallow` entry.

## 22. The portal keeps the session token in memory only

- **Decision:** The admin session token is held only in memory in the portal and
  is never written to browser storage; the admin key and code are discarded
  after sign-in. Closing or reloading the tab signs the admin out. All portal
  content is inserted as text, never as HTML.
- **Reason:** A token in browser storage outlives the tab and is readable by any
  script that ever runs on the origin; keeping it in memory bounds its life to
  the page. Inserting content as text removes the stored-XSS surface entirely.
- **Alternative rejected:** Keeping the token in browser storage for convenience.

## 23. The portal shows payer phone numbers masked

- **Decision:** The admin portal shows payer phone numbers masked (the first 4
  and last 2 digits). Full numbers are obtained only through the data-request
  runbook queries.
- **Reason:** The admin endpoint intentionally retains `phoneNumber` for dispute
  resolution, but the portal is a read-mostly view over a shared screen; masking
  keeps the full number out of the page while leaving the endpoint unchanged.
- **Alternative rejected:** Showing full numbers in the portal.

## 24. The 2FA setup write is conditional on the account not being enrolled

- **Decision:** The 2FA setup write is conditional on the account not being
  enrolled, so an enrolled factor can never be replaced even if an
  application-level check were bypassed.
- **Reason:** The `findOneAndUpdate` that stores a fresh seed filters on
  `{ username, totpEnabled: { $ne: true } }`, so an upsert against an enabled
  account cannot insert a duplicate `username` and the unique index rejects it
  with a duplicate-key error. That makes the protection structural rather than a
  single application check that a future refactor could drop.
- **Alternative rejected:** relying on the application check alone.

## 25. The Escape key closes the listing and report modals but not the store modal

- **Decision:** The Escape key closes the listing and report modals but
  deliberately not the store modal, because closing the store modal aborts a
  pending payment poll and an accidental keypress must not do that.
- **Reason:** The store modal hosts the store-payment flow; `closeStoreModal()`
  calls `clearStorePoll()` to abort its pending status poll. Binding Escape to
  it would let a stray keypress silently cancel an in-flight payment check.
- **Alternative rejected:** Escape closing every modal.

## 26. Payment-initiation buttons restore their label, they do not relabel to Retry

- **Decision:** Payment-initiation buttons (store plan, boost) do not relabel to
  Retry after a failure; they restore their original label. A one-click retry
  after a network failure could start a second payment request.
- **Reason:** A retry button invites an immediate second submit; for a payment
  that means a second STK push. Restoring the original label forces the seller to
  make a deliberate action, and the recovery affordance is offered separately.
- **Alternative rejected:** A Retry label on payment buttons.

## 27. A failed replacement photo upload restores the previously confirmed photo

- **Decision:** A failed replacement photo upload restores the previously
  confirmed photo; there is no automatic retry button, the seller picks the file
  again.
- **Reason:** Clearing the photo on failure silently submits a listing without an
  image the seller had already chosen, and the rejected pick is not what they
  confirmed. Restoring the confirmed photo keeps the listing publishable as-is,
  and the status line names the outcome (" Your previous photo was kept.").
- **Alternative rejected:** Clearing the photo on failure.

## 28. Moderation matches normalized and de-spaced text

- **Decision:** Moderation matching also tests a normalized copy of the text
  (look-alike digits and symbols next to letters, zero-width characters,
  full-width letters) and a copy with single-letter spacing removed. Digits and
  symbols are only converted when they touch a letter, so numbers and prices are
  never altered. This raises the bar; it does not stop a determined evader, and
  reports remain the main safety net.
- **Reason:** A plain substring filter is trivially defeated by "c4s1n0" or
  "c a s i n o"; testing a normalized and de-spaced variant of the same text
  catches the common cosmetic evasions without changing any existing pattern.
- **Alternative rejected:** Matching with all non-letters removed (causes false
  positives); an external moderation service.

## 29. Backups run through mongodump; scheduling and Atlas backup are outside the repository

- **Decision:** Backups are taken with `mongodump` through `npm run backup`;
  scheduling and Atlas continuous backup are configured outside the repository.
  The restore drill restores into a scratch database namespace.
- **Reason:** `mongodump` writes a portable dump that can be restored into any
  scratch cluster, which is the only way to prove a backup is usable. The
  scheduler and Atlas continuous backup live in the host and the Atlas dashboard,
  which this repository cannot reach, so they stay manual, documented steps.
- **Alternative rejected:** An in-process scheduled backup (cannot protect
  against loss of the host).

## 30. Payments completed by an admin grant are marked with grantedBy and grantedAt so they can be told apart from real payments.

- **Decision:** Payments completed by an admin grant are marked with grantedBy
  and grantedAt so they can be told apart from real payments.
- **Reason:** An admin grant produces the same `status: 'completed'` as a real
  IntaSend webhook, so without a marker a granted payment is indistinguishable
  from a paid one — it would inflate revenue totals and could not be audited or
  counted separately. Stamping `grantedBy` and `grantedAt` in the same atomic
  write as the status transition keeps the two paths distinguishable at the
  database level.
- **Alternative rejected:** Inferring grants from the audit log at read time
  (the audit write is fire-and-forget, so a payment could complete without a
  readable event).

## 31. The grant tab previews the payment before granting and grants only the previewed payment id, so a phone number with several pending payments can never grant the wrong one.

- **Decision:** The grant tab previews the payment before granting and grants
  only the previewed payment id, so a phone number with several pending payments
  can never grant the wrong one.
- **Reason:** A `phoneNumber` selector resolves to the most recent pending
  payment, which is invisible to the admin at grant time; the same number can
  have several pending rows. Previewing first shows exactly which payment will be
  granted (type, name, plan, created time, masked phone), and sending the
  previewed id back as `paymentId` makes the granted record provably the one that
  was shown. The Grant button stays disabled until a preview succeeds for the
  current inputs, and any edit invalidates it.
- **Alternative rejected:** Granting directly from the phone number and trusting
  the server's most-recent choice.

## 32. GikoMart is institution-neutral; location defaults are local (Njoro)

- **Decision:** GikoMart names no university or educational institution in its
  UI, legal pages, package metadata or defaults. Where a geographic location is
  useful the value is **Njoro**; where it is not, the institution reference is
  removed rather than swapped for another institution. `Store.campus` keeps its
  field (for compatibility — it is returned by the public store API) but defaults
  to `'Njoro'`, `Listing.location` defaults to `'Njoro'`, and the
  `paymentController` store-creation fallback is `'Njoro'`.
- **Reason:** The product is a local marketplace for students, residents and
  communities, not an institutional service; presenting an institution implies an
  affiliation, ownership or endorsement the operator does not have. Keeping the
  `campus` field with a neutral default avoids a schema/API change while stopping
  new records from carrying the institution.
- **Alternative rejected:** Removing the `campus` field outright (unnecessary API
  and schema churn) and replacing the institution with another institution
  (merely moves the same false association).

## 33. The access log records `req.ip`, not the raw `X-Forwarded-For` header

- **Decision:** The access log records `req.ip`, the same address the rate
  limiters and the admin lockout use, not the raw `X-Forwarded-For` header, which a
  client can set itself.
- **Reason:** The raw header is client-controlled, so logging it lets a caller
  choose its own recorded address, and a multi-hop chain is logged as one
  comma-separated string. `req.ip` is resolved through the bounded `trust proxy`
  hop count, so the logged address now matches the address the security controls
  actually enforce.
- **Alternative rejected:** Continuing to log the raw `X-Forwarded-For` header.

## 34. Admin TOTP login keeps the full ±1 drift window and tracks the accepted step

- **Decision:** `POST /api/admin/login` treats a null `verifyDelta({ window: 1 })`
  result as the only out-of-window rejection, and its replay guard rejects a code
  whose time step is `<= lastUsedCounter`, recording the accepted step
  (`counter + delta`). It does not reject `delta < 0`.
- **Reason:** `window: 1` is speakeasy's *two-sided* ±1 tolerance: matching the
  previous, current and next step is the point of configuring it. Rejecting
  `delta < 0` silently made the window one-sided, so any authenticator (or server)
  clock behind the other was refused even though its code was still inside the
  configured window — and because the code comment and the option both advertise
  ±1 drift, the behavior contradicted its own configuration. Storing the accepted
  step (not the server's current step) keeps one-use-per-code replay protection
  across the whole window while allowing in-window codes.
- **Alternative rejected:** Removing the replay check so every in-window code is
  accepted — that disables replay protection. Also rejected: keeping `delta < 0`
  and widening `window`, which merely hides the one-sided guard behind a larger
  tolerance.

## 35. Free Grant is a request → admin decision → seller redemption that converges on the paid provisioning function

- **Decision:** A free package is modelled as a `GrantRequest` — an
  administrative access request, not a payment. A public request stores only
  `sha256(claimToken)` and returns the raw token once to the requesting browser.
  An admin approves or rejects it atomically (`findOneAndUpdate` on
  `{ _id, status: 'pending' }`). On approval the SELLER's browser redeems it:
  the owner token is minted in that redeem request (never in the admin's), and a
  payment-shaped object is passed to the existing `createResourceForPayment()`
  with the request `_id` as the unique-sparse `paymentId`.
- **Reason:** The admin's browser is not the seller's, so an owner token minted
  at approval could never reach the seller; and `createResourceForPayment()`
  consumes a full resource payload that a bare WhatsApp number does not contain.
  A redeem step resolves both while reusing the single provisioning convergence
  point and inheriting its idempotency (unique-sparse `paymentId` + E11000
  re-read), moderation, expiry and listing limits. Writing no `Payment` row keeps
  grants out of revenue and payment metrics by construction, and keeps the paid
  flow and the existing Grant Free Access untouched.
- **Alternative rejected:** A synthetic zero-amount `Payment` row (invents a
  financial record and pollutes pending/revenue metrics) and creating
  Listing/Store directly inside the grant controller (a second provisioning
  engine to maintain).

## 36. Free Grant approval is terminal — there is no unapprove path

- **Decision:** `POST /api/admin/grants/:id/approve` moves a `GrantRequest`
  `pending → approved` once, and no endpoint ever writes `status: 'pending'`
  to an existing request; `reject` exists but matches `pending` only. The
  admin queue deliberately offers no unapprove action — the only levers kept
  after approval are minting a continuation token and the cosmetic `isTest`
  QA flag, neither of which touches the decision.
- **Reason:** *Atomicity* — every transition is one-way by construction:
  approve and reject are single `findOneAndUpdate` calls that put the current
  status inside the filter (`{ _id, status: 'pending' }`), and redemption
  claims `status: 'approved'` AND `provisioned: null` atomically. An unapprove
  would be the first backwards edge in this machine, and it would race the
  seller's client (which polls and flips to the redemption form shortly after
  approval), race an in-flight provisioning, or strand a minted continuation
  token — minting is valid only for approved-unprovisioned grants and
  redemption requires `approved`, so a reverted grant leaves minted
  credentials in limbo. *Audit* — `admin.grant_approved` with
  `decidedBy`/`decidedAt` is written by the same atomic update, exactly once,
  so the trail reads as a monotonic story (submitted → approved → (mint) →
  redeem); an unapprove would force either an event that reverses a prior
  event (the latest event no longer implies the document state) or a silent
  status edit with no event at all, and would let an admin approve, let the
  seller redeem, then erase the decision. *Abuse* — approval is the only
  human gate on a path that bypasses payment and provisions a real resource
  keyed to the request `_id` (the same unique-sparse `paymentId` dedupe as
  the paid path); reversible approvals would let a compromised session churn
  approve → redeem → unapprove cycles, leave a live resource whose provenance
  points at an "unapproved" grant, and make the mint-volume alert meaningless
  as an abuse signal.
- **Alternative rejected:** An unapprove/revert endpoint back to `pending`.
  The correction paths that DO exist are deliberately narrower: `reject` for
  requests still pending, the cosmetic `isTest` flag for test or mistaken
  submissions (metadata only), moderation/removal for a produced resource,
  and — if a genuine revoke need ever appears — a NEW terminal state (e.g.
  `revoked`) with its own audit event and explicit resource handling, never
  an edge back to `pending`.

## 37. Buyer gate: when the server returns no seller contact, re-enable the Continue button and show a toast. Backend requirement for sellerWhatsapp at listing creation is intentionally NOT changed; it is a product decision awaiting the owner.

- **Decision:** In `_handleBuyerGateContinue` (public/assets/js/app.js), an OK
  response from `POST /api/terms/contact-acceptance` whose body carries no
  `sellerWhatsapp` now takes the new `else` branch: the Continue button is
  re-enabled with its original label and the toast "⚠️ This seller hasn't
  shared a contact number. Try another listing." is shown. Previously the
  only re-enable path was the error `catch`, so the missing-contact case left
  the button disabled on "Checking…" indefinitely with no message.
- **Scope boundary:** The backend was NOT changed. A listing can still be
  created without a `sellerWhatsapp` (the sell form's `f-whatsapp` field is
  client-side `required` only); making the number a server-side requirement
  would change creation contracts and is deliberately deferred to the product
  owner. The missing-contact case therefore remains possible and now degrades
  gracefully instead of dead-ending.
- **Alternative rejected:** Hiding the "Contact seller on WhatsApp" button in
  the listing modal when no contact exists. The pre-gate modal never knows
  whether a contact exists (contact PII is stripped from all public list and
  detail responses), so the UI cannot make that call without an extra probe
  request; the gate flow is the only place the truth is revealed.

## 38. UI verification uses a mock-API rig on express

- **Decision:** Browser verification of the frontend runs against
  `tools/ui-rig/server.js` (`npm run rig`), a plain express server that serves
  the real `public/` folder and answers the routes the frontend calls with
  response shapes copied from the real controllers. Scenario behaviour
  (empty, slow, offline, 500, 503, payment outcomes, grant states) is
  controlled at runtime from a control page; localStorage seeding buttons
  write the same token prefixes app.js reads.
- **Reason:** The test suite uses in-memory model fakes injected into
  `require.cache` — there is no mongod, no mongodb-memory-server and no seed
  script in the repo — so a real backend needs a database plus real Cloudinary
  and IntaSend credentials, none of which should be required to verify UI
  behaviour. The rig also exercises the real `app.js` against real markup
  over real HTTP, which source-level audits and jsdom tests cannot: viewport
  layout, console errors, network failure banners and scenario transitions.
- **Alternative rejected:** Real Mongo via Docker. It would couple UI
  verification to container availability, credentials and data seeding, and
  would still not cover IntaSend/Cloudinary-dependent surfaces without double
  staging. The controllers' response shapes are copied, not re-invented, so
  the rig stays honest about what the real API actually returns. eslint.config.js
  gained a tools/** block mirroring the src/** block so the rig lints under
  the same rules; no rules were relaxed.
