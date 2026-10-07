#!/usr/bin/env node
/**
 * Asset version guard.
 *
 * app.js and style.css are mutable and served with long-lived caching; the
 * HTML references them through a ?v= cache-buster that must be bumped on every
 * asset change (see the comment on the app.js script tag in
 * public/index.html). This script makes a forgotten bump a hard failure.
 *
 * Usage:
 *   node scripts/check-asset-version.js            check mode (CI): exit 1 on drift
 *   node scripts/check-asset-version.js --update   regenerate .asset-hashes.json
 *                                                  from current state (local only)
 *
 * What check mode enforces:
 *   1. public/assets/js/app.js sha256 matches .asset-hashes.json ("app.js").
 *      If it differs, the ?v= on the app.js script tag in public/index.html
 *      must have been bumped AND the hashes refreshed (--update); either
 *      missing piece fails with a message saying which.
 *   2. public/assets/css/style.css sha256 matches ("style.css"). If it
 *      differs while the style.css <link> in public/index.html carries no
 *      ?v= at all, that fails unconditionally; if a ?v= is present, the hash
 *      must have been refreshed with --update.
 *
 * Regeneration workflow after an intentional asset change:
 *   1. Bump ?v= on the app.js tag (and the style.css link once it carries one).
 *   2. Run: node scripts/check-asset-version.js --update
 *   3. Commit the refreshed .asset-hashes.json together with the asset change.
 *
 * CI runs the check form only — never --update.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const HASH_FILE = path.join(ROOT, '.asset-hashes.json');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const ASSETS = [
  { key: 'app.js', file: path.join(ROOT, 'public', 'assets', 'js', 'app.js') },
  { key: 'style.css', file: path.join(ROOT, 'public', 'assets', 'css', 'style.css') },
];

function sha256(file) {
  // file is always a path.join-built constant defined above, never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function appJsVersion(html) {
  const match = html.match(/app\.js\?v=([A-Za-z0-9]+)/);
  if (!match) {
    fail('No ?v= found on the app.js script tag in public/index.html — the cache-buster is mandatory.');
  }
  return match[1];
}

function styleCssVersion(html) {
  // Optional-nested groups make this regex conservative-flagged; in practice it
  // is linear ([^"]* cannot match a quote, so backtracking is bounded).
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = html.match(/href="[^"]*style\.css(\?v=([A-Za-z0-9]+))?"/);
  if (!match) {
    fail('No style.css <link> found in public/index.html.');
  }
  return { hasLink: true, hasV: Boolean(match[2]), v: match[2] || null };
}

function fail(message) {
  process.stderr.write(`asset-version-guard: FAIL\n${message}\n`);
  process.exit(1);
}

function update() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const record = { v: appJsVersion(html) };
  for (const { key, file } of ASSETS) {
    record[key] = sha256(file);
  }
  fs.writeFileSync(HASH_FILE, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`asset-version-guard: .asset-hashes.json updated (v=${record.v})\n`);
}

function check() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(HASH_FILE, 'utf8'));
  } catch (err) {
    fail(`Cannot read .asset-hashes.json (${err.message}). Regenerate with: node scripts/check-asset-version.js --update`);
  }

  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const currentV = appJsVersion(html);
  const style = styleCssVersion(html);

  // 1. app.js — hash drift requires a ?v= bump AND refreshed hashes.
  const currentAppHash = sha256(ASSETS[0].file);
  if (currentAppHash !== stored['app.js']) {
    if (currentV === stored.v) {
      fail(`public/assets/js/app.js changed but ?v= stayed "${stored.v}". Bump ?v= on the app.js script tag in public/index.html, then run: node scripts/check-asset-version.js --update`);
    }
    fail(`public/assets/js/app.js changed and ?v= was bumped (${stored.v} → ${currentV}), but .asset-hashes.json is stale. Run: node scripts/check-asset-version.js --update and commit it with the change.`);
  }

  // 2. style.css — hash drift with no ?v= on the link is always a failure.
  const currentCssHash = sha256(ASSETS[1].file);
  if (currentCssHash !== stored['style.css']) {
    if (!style.hasV) {
      fail('public/assets/css/style.css changed but its stylesheet link in public/index.html carries no ?v= cache-buster. Add one, then run: node scripts/check-asset-version.js --update');
    }
    fail('public/assets/css/style.css changed but .asset-hashes.json is stale. If its cache-buster was bumped, run: node scripts/check-asset-version.js --update — otherwise bump ?v= on the style.css link first.');
  }

  process.stdout.write(`asset-version-guard: OK (v=${currentV})\n`);
}

if (process.argv.includes('--update')) {
  update();
} else {
  check();
}
