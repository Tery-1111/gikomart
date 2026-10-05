# Runbook — Grant requests (Free Grant queue)

The day-to-day procedure for the **Grant requests** tab: reviewing requests,
handling lost claim tokens with a continuation token, sending credentials
safely, and reading the audit trail. The underlying API and configuration are
documented in `docs/API_AND_CONFIG.md` (§j). Background: a Free Grant bypasses
**payment only** — provisioning, moderation, expiry and ownership are identical
to a paid purchase.

## The queue

**Grant requests** lists Free Grant submissions, newest first, with the full
normalized WhatsApp number (the same number wa.me uses) and a two-click
**WhatsApp Seller** link. The status filter has four views:

- `pending` (default) — needs a decision. Each row offers **Approve** and
  **Reject**, both two-click confirmed. A rejected request is terminal for the
  seller; approval is terminal too — there is **no unapprove path** (see
  "When to mint" below for the only lever you keep after approving).
- `approved` — approved and waiting for the seller to redeem, or already
  redeemed.
- `rejected` — terminal history.
- `provisioned` — approved requests whose seller has redeemed them (derived
  client-side from the approved view; nothing to act on).

Views refresh only when opened or filtered — there is no live polling.

## When to mint a continuation token

The claim token — the credential a seller redeems with — is created once when
the seller submits and lives only in **their** browser's localStorage. If they
cleared it, switched phones, or lost the device before redeeming, an approved
grant becomes unredeemable. That is the one situation the mint button exists
for:

**Mint only when ALL of these hold:**

1. The grant is `approved` and shows under the approved filter (the button
   appears on exactly those rows — approved and not yet provisioned).
2. The seller says they cannot redeem — cleared storage, new phone, lost
   device. Ask them to try the **Continue on another device** link in their
   pending card first; if they still have it, no mint is needed.
3. You can reach the seller on WhatsApp in the same session you mint (see
   below — the token is shown once).

**Do not mint:**

- As a "resend" when the seller has the original working (minting revokes the
  token they hold — it can lock them out, not help them).
- Proactively "just in case" — every mint invalidates a credential and shows
  up in the audit trail.
- For a provisioned grant (button won't exist; the resource is already theirs
  via the owner token).

**Revocation is a feature:** minting replaces the stored hash, so the OLD token
stops working the moment the new one is issued. If a seller reports a leaked
or compromised link, minting a replacement is the right response — then send
the new link safely.

## How to mint and send it safely

1. Open the **approved** filter and find the row (confirm the WhatsApp number
   matches the seller you are talking to).
2. Click **New continuation link** twice (two-click confirm). The row then
   shows, in place:
   - **Open link** — the `https://…/#grant=<id>/<token>` continuation link.
   - **WhatsApp Seller** — a wa.me link with the message pre-filled, the
     continuation link already inside it.
   - **Copy link** — copies the continuation link to the clipboard.
3. Prefer the **WhatsApp Seller** action: it opens the chat with the right
   number and the right message, and the link never passes through anything
   you type by hand. Copy link is the fallback if the seller asks you to send
   it somewhere else.
4. The token is shown **only this once** and only inside that link/message —
   the portal never stores, re-displays, or lets you re-copy it later. If you
   close the tab before sending, mint again (which revokes the unused one).
5. **Send it to the seller only** — never to a group, never in a forwarded
   message with other recipients, never to anyone claiming to be "the seller's
   friend". The message text itself tells the seller the link is private.
6. **The admin will never need the seller's token for anything else.** If a
   "seller" (or anyone) asks you to read a token out or paste a link they
   supplied, that is a social-engineering red flag — the seller never needs to
   send their token to the admin, and you never need to accept one.
7. Done. The seller opens the link, and their browser picks the grant up
   exactly like their original submission; they then redeem and receive the
   owner token for the listing/store.

## What the audit entries mean

All of these appear in the **Audit log** tab (resource `grant`):

| Action | Meaning | Fields of interest |
|---|---|---|
| `grant.requested` | A seller submitted a Free Grant request | type, package/plan |
| `admin.grant_requests_viewed` | An admin opened the queue (normal noise) | count, status viewed |
| `admin.grant_approved` / `admin.grant_rejected` | A decision was made (actor = admin username) | type |
| `admin.grant_continuation_minted` | A new credential was minted; the old token died at that instant | type — **no token material, by design** |
| `admin.grant_mint_volume_alert` | Automatic alarm: mint volume in the last hour reached the threshold (`GRANT_MINT_ALERT_THRESHOLD`, default 5). Advisory only — verify the mints were seller-requested | count, windowMinutes, threshold |
| `grant.redeemed` | The seller redeemed and the listing/store was created | resource id |

Two things to remember when reading entries: a mint entry records **that** a
credential was replaced, never **what** it was (the raw token exists only in
the mint response and in whatever you sent the seller); and
`admin.grant_continuation_minted` is the entry to reconcile — every mint
should trace to a seller conversation you had. If one does not, treat the
grant's credential as compromised: contact the seller, and mint again once
they confirm (which kills whatever the unexplained mint produced).

## If something goes wrong

- **Minted but not yet sent / sent to the wrong chat:** mint again. The
  accidental link dies instantly; send the fresh one correctly.
- **Seller says even the new link does not work:** confirm they are opening it
  on a device where the URL bar ends with the `#grant=…` fragment intact
  (copy-paste, not re-typing), then mint once more. Repeated failures are a
  support signal, not a security one.
- **Seller never redeems:** the grant simply stays approved-unprovisioned.
  It cannot become a listing without a valid token redeeming it, and there is
  deliberately no admin path to force one.
