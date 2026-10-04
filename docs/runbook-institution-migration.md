# Runbook — Institution-reference data migration

Companion to the code-side neutrality change (`docs/DECISIONS.md` 32). The code
change stops **new** records from receiving an institution default; this runbook
covers the **existing** records that still hold the former institution name in
`Store.campus` and `Listing.location`.

The script is **read-only by default**. Nothing is written unless `--apply` is
passed, and this runbook requires approval and a backup before that step.

Script: `scripts/audit-institution-refs.js`.

The legacy name to match is supplied at run time through the
`LEGACY_INSTITUTION_TOKEN` environment variable, so no institution name is
stored in the repository. The token is matched literally and case-insensitively
against two fields:

| Collection | Field | Match → replacement |
|---|---|---|
| `stores` | `campus` | institution value → `'Njoro'` |
| `listings` | `location` | institution value → `'Njoro'` |

## Preconditions

- [ ] The legacy institution name is available to pass as
      `LEGACY_INSTITUTION_TOKEN` (the value removed by this cleanup).
- [ ] **Operator approval** to modify the target database is obtained in writing.
- [ ] You know which database `MONGO_URI` points at (confirm it is the intended
      environment — never run `--apply` against production without approval).
- [ ] A fresh backup exists: `npm run backup` (see
      `docs/runbook-backup-restore.md`).
- [ ] No other migration or deploy is running.

## Step 1 — Audit (read-only, safe to run anytime)

```bash
LEGACY_INSTITUTION_TOKEN=<legacy-name> npm run audit:institution
```

Expected output per field: a count and up to 10 sample `_id` values. The script
never prints the connection string or its credentials, and it makes no writes in
this mode.

If both counts are `0`, there is nothing to migrate — stop here.

## Step 2 — Review and approve

- [ ] Record the counts (stores, listings) in the change ticket.
- [ ] Confirm the sampled values are the institution name and not user-entered
      text that merely contains the token (e.g. a seller who typed an address).
      If legitimate user content is caught, note it — the script rewrites every
      match and has no exclude option, so handle those ids with a targeted manual
      update instead of `--apply`.
- [ ] Obtain explicit operator sign-off to proceed.

## Step 3 — Apply

```bash
LEGACY_INSTITUTION_TOKEN=<legacy-name> node scripts/audit-institution-refs.js --apply
```

- [ ] Capture the printed `[apply]` `modifiedCount` values.
- [ ] Confirm `modifiedCount` is not greater than the audited counts.

## Step 4 — Verify

```bash
LEGACY_INSTITUTION_TOKEN=<legacy-name> npm run audit:institution
```

- [ ] Both counts are now `0`.
- [ ] Spot-check one previously affected store/listing in the app or via the
      public API to confirm the location reads `Njoro` and nothing else changed.

## Rollback

The script only changes two string fields; it does not delete records. To reverse
it, restore from the Step-0 backup (`docs/runbook-backup-restore.md`) or re-set the
fields manually. Because the pre-migration values are not stored, the backup is
the only exact rollback — hence the backup precondition.

## Out of scope / external boundaries

These are **not** changed by this script and were not verifiable from the
repository; handle them separately after approval:

- Render environment variables — in particular `WHATSAPP_GROUPS`, whose value is
  not visible in the repository and may name institution-specific groups.
- Cloudinary media (uploaded logos/images).
- The live deployment at `https://gikomart.onrender.com`.
- IntaSend, Whapi/WhatsApp, GoatCounter dashboards and DNS/domain registration.
- Any `Store.pickup_location` / `Store.location` free text that a person typed
  containing the institution name (the script intentionally does not touch
  owner-entered free text).
