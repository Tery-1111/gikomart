/**
 * Production configuration guard.
 *
 * Fails fast when a security-critical secret is missing or left at its
 * documented placeholder while running in production. Development and test are
 * deliberately exempt: local runs and the CI suite use throwaway values, and
 * the point is to stop a misconfigured production deploy — not to make
 * `npm test` require real secrets.
 *
 * ADMIN_SESSION_SECRET has no safe fallback: `signSession`/`verifySession` HMAC
 * with whatever the value is, so an absent value would make every admin session
 * token forgeable. ADMIN_KEY is the (pre-2FA) admin credential and the default
 * "changeme" grants admin access.
 *
 * INTASEND_WEBHOOK_CHALLENGE fails open in paymentController: the webhook guard
 * compares the body's `challenge` against this value, so an unset value makes
 * `undefined !== undefined` false and accepts a forged webhook that omits the
 * challenge field. Requiring it here keeps that guard fail-closed.
 */
const INSECURE_DEFAULTS = new Set(['changeme', 'undefined', '']);

// Minimum acceptable length for a production secret. Short keys are brute-forcible
// and offer no real protection even when they are not one of the documented
// placeholders above.
const MIN_SECRET_LENGTH = 16;

// A secret is insecure when it is absent, a known placeholder, or shorter than
// MIN_SECRET_LENGTH. Values are never logged or returned — only the variable name.
function isInsecureSecret(value) {
  return !value || INSECURE_DEFAULTS.has(value) || String(value).length < MIN_SECRET_LENGTH;
}

// Pure: returns the names of insecure secrets for the given env (empty when the
// environment is not production or everything is set). Exported for testing.
function findInsecureProductionSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  if (isInsecureSecret(env.ADMIN_KEY)) {
    problems.push('ADMIN_KEY');
  }
  if (isInsecureSecret(env.ADMIN_SESSION_SECRET)) {
    problems.push('ADMIN_SESSION_SECRET');
  }
  if (isInsecureSecret(env.INTASEND_WEBHOOK_CHALLENGE)) {
    problems.push('INTASEND_WEBHOOK_CHALLENGE');
  }
  return problems;
}

// Side-effecting: logs and exits the process. `onFatal` is injectable so the
// guard itself can be tested without terminating the test runner.
function assertProductionSecrets(env = process.env, onFatal) {
  const problems = findInsecureProductionSecrets(env);
  if (problems.length === 0) return;
  const message = `Refusing to start: insecure production secret(s): ${problems.join(', ')}. `
    + 'Set strong, non-default values in the deployment environment.';
  if (onFatal) {
    onFatal(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

// Startup configuration guard: the app cannot function without a database, so a
// missing MONGO_URI is fatal for every environment except the test suite (which
// injects fakes and never connects). The message names the variable only —
// never its value.
function assertStartupConfig(env = process.env, onFatal) {
  const problems = [];
  if (env.NODE_ENV !== 'test' && (!env.MONGO_URI || String(env.MONGO_URI).trim() === '')) {
    problems.push('MONGO_URI');
  }
  // In production the block list is keyed by HMAC with BLOCK_HASH_SECRET; a
  // missing or short secret would either throw at hash time or leave the keyed
  // hashes brute-forcible, so refuse to start. Test and development keep the
  // documented fallback in src/utils/phone.js. MIN_SECRET_LENGTH is the same
  // 16-character bar the other production secrets use.
  if (env.NODE_ENV === 'production'
      && (!env.BLOCK_HASH_SECRET || String(env.BLOCK_HASH_SECRET).length < MIN_SECRET_LENGTH)) {
    problems.push('BLOCK_HASH_SECRET');
  }
  if (problems.length === 0) return;
  const message = `Refusing to start: missing required configuration: ${problems.join(', ')}. `
    + 'Set it in the deployment environment.';
  if (onFatal) {
    onFatal(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

module.exports = { findInsecureProductionSecrets, assertProductionSecrets, assertStartupConfig };
