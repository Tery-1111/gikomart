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

// Pure: returns the names of insecure secrets for the given env (empty when the
// environment is not production or everything is set). Exported for testing.
function findInsecureProductionSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') return [];
  const problems = [];
  if (!env.ADMIN_KEY || INSECURE_DEFAULTS.has(env.ADMIN_KEY)) {
    problems.push('ADMIN_KEY');
  }
  if (!env.ADMIN_SESSION_SECRET || INSECURE_DEFAULTS.has(env.ADMIN_SESSION_SECRET)) {
    problems.push('ADMIN_SESSION_SECRET');
  }
  if (!env.INTASEND_WEBHOOK_CHALLENGE || INSECURE_DEFAULTS.has(env.INTASEND_WEBHOOK_CHALLENGE)) {
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

module.exports = { findInsecureProductionSecrets, assertProductionSecrets };
