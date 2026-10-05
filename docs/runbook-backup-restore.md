# Backup and Restore Runbook

How to take a MongoDB backup and prove it can be restored. Everything here is
read from `scripts/backup.js` and the `backup` script in `package.json`; anything
the script does not make clear is marked **Not confirmed** rather than guessed.

Never paste a real connection string, database name, or credential into this
document. Use the placeholders shown.

## 1. Take a backup

```bash
npm run backup
```

- The script runs `mongodump --uri "$MONGO_URI" --out <dir>`, where `MONGO_URI`
  comes from the environment (`.env` is loaded by the script).
- Output goes to `backups/<timestamp>/`, where `<timestamp>` is the run time in
  `YYYY-MM-DDTHH-MM-SS-mmmZ` form (the ISO timestamp with `:` and `.` replaced by
  `-`). `mongodump` writes one subdirectory per database inside it.
- It needs `mongodump` installed on the host (part of the MongoDB Database
  Tools). If it is missing, the script exits non-zero.
- `backups/` is ignored by git (`.gitignore`). It therefore lives only on the
  machine that ran the command — copy each dump somewhere safe (an encrypted
  off-host store) or it is not a backup.
- The script prints only `Backup complete → <outDir>` on success. It never prints
  the connection string or its credentials.

## 2. Atlas backups

- Atlas **continuous backups** are turned on in the Atlas dashboard for the
  cluster. This cannot be done from this repository.
- **Manual step:** confirm in the Atlas dashboard that continuous backups are
  enabled and that the retention window is what you expect. Record the date of
  the check outside the database.

## 3. Restore drill into a scratch database

Restore a dump into a scratch namespace so the live data is never touched. Use a
separate scratch cluster (or a database name you are sure is unused); set
`SCRATCH_MONGO_URI` to its connection string.

```bash
mongorestore --uri="$SCRATCH_MONGO_URI" --nsFrom="LIVE_DB_NAME.*" --nsTo="restore_drill.*" PATH_TO_DUMP_FOLDER
```

- `PATH_TO_DUMP_FOLDER` is the dump directory from section 1, i.e.
  `backups/<timestamp>` (the folder `mongodump` wrote).
- `LIVE_DB_NAME` is the source database name inside that dump. The script does
  not print it — **Not confirmed** by the script; read it from the dump
  directory (it is the top-level folder name under `backups/<timestamp>/`) or
  from the Atlas cluster.

Then check the restored data:

```js
// In mongosh connected to SCRATCH_MONGO_URI:
use restore_drill
db.getCollectionNames()
db.listings.countDocuments()
db.stores.countDocuments()
db.payments.countDocuments()
db.grantrequests.countDocuments()
db.termsacceptances.countDocuments()
db.auditevents.countDocuments()
```

The counts should match what you expect for the live database at the dump time.
An empty or partial result means the dump or the namespace mapping is wrong.

## 4. After the drill

- Drop the scratch database so it does not linger:
  `use restore_drill` then `db.dropDatabase()` in mongosh.
- Record the date and the result of the drill **outside the database** (a
  changelog or an ops note), so the evidence survives a lost cluster.

## 5. Schedule

- The scheduler is **not** in this repository — there is no cron or timer wired
  here. Configure it in the host: a Render cron job, GitHub Actions, or the
  Windows Task Scheduler, each running `npm run backup`.
- **Manual step:** set the schedule in the host and confirm a run has produced a
  dump under `backups/` before relying on it.
