#!/usr/bin/env node
/**
 * Automated MongoDB backup script
 *
 * Runs `mongodump` against the MONGO_URI in .env and writes a timestamped dump
 * directory under /backups. Intended to be invoked by a scheduled job (Render
 * cron, GitHub Actions, or Windows Task Scheduler):
 *
 *   node scripts/backup.js
 *
 * Edge case: the MONGO_URI may contain credentials. mongodump accepts a
 * `mongodb+srv://` connection string via `--uri`. Passphrase-free dockerized
 * Atlas free-tier instances support mongodump directly.
 *
 * Phase 4B — Security Hardening
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const backupRoot = path.join(__dirname, '..', 'backups');

function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set — aborting backup');
    process.exit(1);
  }

  if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(backupRoot, timestamp);

  // mongodump must be installed (part of mongodb-tools / mongodb-database-tools).
  execFile('mongodump', ['--uri', uri, '--out', outDir], (err, stdout, stderr) => {
    if (err) {
      console.error('Backup failed:', stderr || err.message);
      process.exit(1);
    }
    console.log(`Backup complete → ${outDir}`);
    process.exit(0);
  });
}

run();