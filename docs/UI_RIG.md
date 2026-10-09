# GikoMart UI Verification Rig

A mock-API server for verifying the GikoMart frontend in a browser without a
real backend. It serves the repo's actual `public/` folder and answers the
exact routes the frontend calls with response shapes copied from the real
controllers — so UI states (empty, slow, offline, payment outcomes, grant
states) can be exercised deterministically.

The rig never imports src/ and never touches a database.

## Linting

`tools/**/*.js` lints under a dedicated `eslint.config.js` block mirroring the
`src/**` block — same CommonJS source type, Node globals and security-plugin
ruleset; no rules were relaxed.

## How to start

```bash
npm run rig            # listens on http://127.0.0.1:4173 (RIG_PORT to override)
```

Then open:

- The app: `http://127.0.0.1:4173/`
- The control page: `http://127.0.0.1:4173/__rig/`

## Scenario table

Set on the control page (server-side state, applies to all new /api calls):

| Scenario       | Behaviour |
|----------------|-----------|
| `normal`       | Every route succeeds. |
| `empty`        | Listing routes return zero listings (`total: 0`). |
| `slow`         | Normal, plus a fixed extra 2500 ms on every /api response. |
| `offline`      | Every /api socket is destroyed (fetch rejects as a network failure). |
| `server-error` | Every /api returns 500 `{ error: 'Internal Server Error' }`. |
| `busy`         | Every /api returns 503. |
| `no-contact`   | Normal, but `POST /api/terms/contact-acceptance` succeeds without `sellerWhatsapp` (DECISIONS 37's dead end). |
| `pay-success`  | Payment initiate succeeds; the first status poll is `pending`, later polls return the listingId. |
| `pay-pending`  | Status is always `pending`. |
| `pay-failed`   | Status is `failed` with a generic failure. |
| `pay-cancelled`| Status is `failed` with `failedCode: '1032'` (provider-confirmed cancellation). |

An additional `latencyMs` input delays every /api response by that many
milliseconds, on top of `slow`'s fixed delay.

## Seed buttons

The control page writes localStorage of the rig origin using the same key
prefixes app.js uses (token value: `rig-token`):

- **Seed seller** — owner tokens for `rig-l-01`, `rig-l-02`, `rig-l-03`
  (`gikomart_ownerToken:<listingId>`), which makes those cards show edit/delete
  controls and the Dashboard show three listings.
- **Seed store owner** — store token `gikomart_storeToken:rig-s-1`, which makes
  the My Store view render the management panel for `rig-store-one`.
- **Seed grant pending / approved / rejected** — writes
  `gikomart_grantToken:<claimId>` and `gikomart_grantMeta:<claimId>`
  (`{"type":"listing","whatsapp":"0712345678","plan":"Standard (7 days)"}`) for
  `rig-claim-pending` / `rig-claim-approved` / `rig-claim-rejected`. The grant
  status is decided by which claim id is seeded, not by the scenario.
- **Clear all** — removes every `gikomart_*` key.

## Simulated routes

| Method + path | Notes |
|---|---|
| `GET /api/support-contact` | phone-only public subset. |
| `GET /api/listings/categories` | the canonical 12-category contract. |
| `GET /api/terms/versions` | fixed v1.0.0 set. |
| `GET /api/listings` | honours `category`, `search` (case-insensitive substring on title), `page`, `limit`, `store_id`; returns the real pagination envelope; list items omit `sellerWhatsapp`. |
| `POST /api/terms/contact-acceptance` | `no-contact` scenario drops `sellerWhatsapp`. |
| `POST /api/reports` | success only. |
| `POST /api/payments/initiate-listing` | succeeds; invoice id tracked for the payment scenarios. |
| `POST /api/payments/initiate-store-plan` | same. |
| `POST /api/payments/boost` | succeeds. |
| `GET /api/payments/status/:invoiceId` | driven by the payment scenarios. |
| `PUT /api/listings/:id`, `DELETE /api/listings/:id` | mutate the in-memory fixtures. |
| `GET /api/stores/slug/:slug` | public store view (contact PII omitted). |
| `GET /api/stores/:id` | owner view; requires `X-Store-Owner-Token: rig-token`. |
| `PUT /api/stores/:id`, `DELETE /api/stores/:id` | mutate the in-memory fixtures. |
| `POST /api/stores/:id/listings` | success; requires the store token. |
| `PUT /api/stores/:id/attach-listing` | success. |
| `POST /api/grants` | returns claim id `rig-claim-pending` with a fresh token. |
| `GET /api/grants/status/:claimId` | status comes from the seeded claim id. |
| `POST /api/grants/:claimId/redeem` | succeeds only for the approved claim. |

Any /api path not listed above returns `404 {"success":false,"error":"Not simulated by the rig"}` and logs the method + path to the rig's console.

## Not-simulated behaviour

- **Real validation** — the rig accepts payloads the real backend would reject;
  it is not a validator.
- **Rate limits** — none; request the same route as fast as you like.
- **Real payments** — no IntaSend; the payment lifecycle is a scenario flag.
- **Real photos** — uploads always return 503; images are five generated SVG
  placeholders served from `/__rig/img/` (square, landscape 4:3, portrait 3:4,
  wide 16:9, tall 9:16).
- **MongoDB / any database** — none; all state is in-memory and resets on
  restart.

The rig never imports src/ and never touches a database.
