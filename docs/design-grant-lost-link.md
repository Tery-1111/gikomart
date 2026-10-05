# Design — "Lost my grant link" seller support flow

Status: **proposed, not implemented.** This document designs the seller-facing
path that makes the admin's continuation-token mint (see
`docs/runbook-grant-requests.md`) discoverable to the seller who needs it —
without exposing tokens, adding a second credential, or giving the seller any
new API power. Every mechanism it wires together already exists in production.

## 1. The problem

The claim credential is device-bound: it lives only in the submitting browser's
localStorage. The recovery path exists — the admin mints a new one, which
revokes the old — but it is **admin-side knowledge**. A seller who cleared
their browser or changed phones sees only the request form again, and the
obvious wrong move is to submit a duplicate request. Nothing in the seller UI
says "ask the admin for a new link", and nothing helps them say it well.

The asymmetry is deliberate: no API can identify a tokenless seller (the token
was the only credential), so recovery is inherently a human conversation on
WhatsApp. The design goal is therefore **not** to recover anything
programmatically — it is to route the seller to the admin with the right words,
safely.

## 2. Principles carried over from the shipped design

- Tokens are returned once, to the browser that owns them, and never travel
  through any read API. Rotation happens only via the session-gated admin mint.
- The claim id (`GrantRequest._id`) is **not** a secret — the status endpoint
  ignores it without a valid token — but it is also never needed by the seller.
- Every recovery decision is conversational: the admin verifies the requester's
  number against the queue and asks what they requested before minting.

## 3. The design — three touchpoints, one new UI piece

### Touchpoint A (the new piece): "Lost your grant link?" panel in the request modal

When the grant modal opens **and no claim token is stored on this device**
(the exact state a tokenless seller is in), render a quiet panel below the
request form — after, and never instead of, the existing resume banner (a
seller who still holds a token sees that banner; this panel does not render
for them):

```
🔑 Lost your grant link?
If you cleared this browser or changed phones since you requested your free
grant, the link stayed behind on the old device. Don't submit a new request —
ask the admin to issue you a new one. It takes a minute and nothing is lost.
  [Copy message for the admin]   [WhatsApp Support]
```

- **Copy message for the admin** (uses the shipped `copyTextToClipboard`)
  puts this on the clipboard:

  ```
  Hi! I made a Free Grant request on GikoMart but I lost my grant link
  (cleared this browser / changed phones).
  My WhatsApp: <number>
  Request: <what was requested>          ← only when the device remembers it
  Claim reference: <claimId>             ← only when the device remembers it
  Could you issue me a new link? Thank you!
  ```

- **WhatsApp Support** opens the same chat the site footer already advertises.
  Implementation reads the footer anchor's `wa.me` href at runtime (single
  source of truth — the number is configured in `public/index.html` only) and
  falls back to copy-only if the footer is ever absent. No new env var, no
  duplicated number in JS. (Flag for the operator: the footer currently points
  at `254700000000`, which looks like a placeholder — this flow is only as
  useful as that number is real.)

- The **claim reference** is included only in the partial-loss case (device
  still holds `gikomart_grantMeta:*` but not the token). It is not a
  credential and grants no access; it simply lets the admin find the record
  without asking. When the device holds nothing, the message is just number +
  request description (typed into a small optional field) + the ask.

- The number field is the seller's own, optional, and goes only into the
  copied text. If left empty the message still works — the admin can match on
  the WhatsApp chat itself, which arrives from the seller's own number anyway.

### Touchpoint B: one prevention sentence in the pending state

The pending card's "Next:" paragraph gains one sentence, so the risk is
visible *before* it happens:

> If you clear this browser or switch devices before approval, use **Continue
> on another device** to take the link with you — or just ask the admin for a
> new one; nothing is lost.

No new controls; the Copy-WhatsApp-message button already carries the link.

### Touchpoint C: admin-side alignment (docs only, mostly shipped)

`docs/runbook-grant-requests.md` already instructs the admin to verify the
number against the queue and confirm what was requested before minting. It
gains one walkthrough: "seller messaged asking for a new link" → find by
number → verify conversationally → mint → send — closing the loop from the
seller's words to the admin's buttons.

## 4. Why this is safe

- **Zero new API surface.** Both touchpoints are pure client-side copy. No
  endpoint can be enumerated, no rate limiter is bypassed, nothing
  authenticated changes.
- **The message confers nothing.** It asks for a mint; it cannot cause one.
  The mint itself remains session-gated, eligibility-checked
  (approved + unprovisioned), and volume-alerted.
- **No credential injection.** The flow asks *for* a credential; the runbook
  already forbids the admin from ever *accepting* one. The two directions
  cannot be confused.
- **No existence leak.** No seller-facing call reveals whether a number has a
  request — the only "lookup" is the admin reading the session-gated queue.
- **Duplicate-request pressure drops**, which is the actual abuse vector this
  creates today (re-submitting is unauthenticated by design; reportLimiter is
  the only brake).
- **No second credential system.** The mint reuses `claimTokenHash`; the
  seller never sees or holds anything except the new fragment link the admin
  sends.

## 5. What is deliberately NOT built

- **No "recover by phone number" endpoint.** It would leak request existence
  and status to anyone who knows a number, need its own rate limiting, and
  still end with "the admin sends you a link" — the conversation is the
  verification.
- **No automatic re-issue.** Eligibility and identity are human judgments
  here; automating them weakens the credential model for no real gain.
- **No token display in the seller UI.** Post-loss there is nothing to
  display — the token never existed server-side.

## 6. Implementation plan (on approval)

1. `public/assets/js/app.js`: `buildGrantLostLinkMessage()`,
   `renderGrantLostLinkPanel()` wired at the end of `openGrantModal()`
   (render only when `findStoredGrant()` returns null), footer-href lookup
   with graceful fallback, one sentence in the pending state. ~90 lines.
2. `public/index.html`: cache-bump to `?v=20261005c` (bump on every JS change).
3. `tests/grantUx.test.mjs`: panel hidden when a stored grant exists (resume
   banner wins); panel present when none; copied message carries number /
   request / claim-ref exactly when available and never contains token
   material; the anchor inherits the footer's wa.me href.
4. Docs: CHANGELOG entry, one sentence in `API_AND_CONFIG.md` §j, the
   runbook walkthrough in `docs/runbook-grant-requests.md`.

Estimated size: ~90 lines JS, ~120 lines tests, ~30 lines docs. No backend
changes at all.
