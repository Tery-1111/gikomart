# Data Request Runbook

How to find and erase a person's data when they make a request. Every query
below is written from the schemas in `src/models/` and the hashing in
`src/utils/phone.js` and `src/services/termsAcceptanceService.js`. Collection
names are the Mongoose defaults (pluralised model names); confirm them against
the live database before running anything.

Replace `PHONE_NUMBER_HERE`, `LISTING_ID_HERE`, `STORE_ID_HERE`, `PAYMENT_ID_HERE`,
`REPORT_ID_HERE` and `HASH32_HERE` with real values when running the queries.
Never paste a real value into this document.

## 1. Before you start

- Take an Atlas backup first, so any mistake can be reversed.
- Never run a `delete` or `update` before a matching `find` that shows exactly
  which documents it will touch.
- Work on one request at a time and record the outcome (section 6).

## 2. Find a requester's records

Run the `find` for each collection and read the results before changing
anything. A number may be stored in more than one format, so try the formats the
requester actually used (for example `07XXXXXXXX`, `2547XXXXXXXX`, `+254 7XX XXX
XXX`) one at a time.

Payment — the payer number as it was typed:

```js
db.payments.find({ phoneNumber: "PHONE_NUMBER_HERE" })
```

Listing — the seller number stored on the listing:

```js
db.listings.find({ sellerWhatsapp: "PHONE_NUMBER_HERE" })
```

Store — the store phone or WhatsApp:

```js
db.stores.find({ $or: [ { phone: "PHONE_NUMBER_HERE" }, { whatsapp: "PHONE_NUMBER_HERE" } ] })
```

Terms acceptance — the hashes are plain sha256 of the value **exactly as it was
typed** (not normalised), so compute the hash for each candidate format and
query each one separately:

```js
db.termsacceptances.find({ $or: [
  { "actor.phoneHash": "HASH32_HERE" },
  { "actor.whatsappHash": "HASH32_HERE" },
  { "sellerContactTarget.sellerWhatsappHash": "HASH32_HERE" }
] })
```

Report — reports carry no phone number; find them by the listing or store they
name:

```js
db.reports.find({ targetId: "LISTING_ID_HERE" })
db.reports.find({ targetId: "STORE_ID_HERE" })
```

The blocked-contact list is keyed by a secret-keyed HMAC, not a plain hash, so it
cannot be queried by computing a sha256. To check whether a number is blocked,
use the admin block endpoint, which reports `alreadyBlocked` without creating a
duplicate: `POST /api/admin/blocks` with `{"sourceType":"phone","phone":"PHONE_NUMBER_HERE","reason":"data request check"}`.

## 3. Erase records

Consistent with the "cannot erase" decisions (section 6), a data request can
erase the contact PII below. Do not delete whole records that are kept as
evidence or for the dispute window.

Payment — erase the payer number and the stored contact copies early (the
scheduled job does this automatically after 90 days):

```js
db.payments.updateOne(
  { _id: ObjectId("PAYMENT_ID_HERE") },
  { $set: { phoneNumber: "redacted", piiStrippedAt: new Date() },
    $unset: { "listingData.sellerWhatsapp": "", "storeData.phone": "",
              "storeData.whatsapp": "", "storeData.email": "" } }
)
```

Listing — a seller can delete their own listing in the app, which also removes
its images. To remove only the contact number:

```js
db.listings.updateOne({ _id: ObjectId("LISTING_ID_HERE") }, { $set: { sellerWhatsapp: "" } })
```

Store — clear the contact fields (the scheduled job does this 30 days after the
store expires):

```js
db.stores.updateOne(
  { _id: ObjectId("STORE_ID_HERE") },
  { $set: { phone: null, whatsapp: null, email: null, location: null, pickup_location: null } }
)
```

Report — clear only the reporter's IP, which exists only for deduplication:

```js
db.reports.updateOne({ _id: ObjectId("REPORT_ID_HERE") }, { $set: { reporterIp: null } })
```

What stays behind: the payment amounts and status (dispute window), the terms
acceptance record minus its 30-day PII (see section 6), the report body, and the
audit trail. Never hand-delete an acceptance record or an audit event to satisfy
a request.

## 4. Blocked numbers

A requester's blocked-contact entry is kept even on a data request. The entry
stores only a keyed hash of the number, its source and a reason, and it exists to
keep a banned number from starting a payment; removing it would let that number
pay again. See `docs/DECISIONS.md` entry 10. Tell the requester this plainly
(section 5).

## 5. What to tell the requester

A plain-language reply:

> Thank you for your data request. We have reviewed the records we hold for the
> phone number and listing or store you gave us.
>
> [State here exactly what was found and what was changed or erased.]
>
> We erase contact data automatically on the schedule published in our Privacy
> Policy. Some records are kept as evidence of the consent you gave, as an
> operational audit trail, or to keep a blocked number out; where that applies we
> will explain which record and why.
>
> If you have further questions, contact us at [SUPPORT_EMAIL]. We will respond
> within 14 days.

## 6. Log of requests

Record each request outside the database — for example in a spreadsheet or a
ticket — with the date, the type of request (access, correction, deletion), and
the outcome. Keep no personal data in the log beyond a reference number that
links the entry to the request email or message.
