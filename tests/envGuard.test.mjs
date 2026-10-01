import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findInsecureProductionSecrets, assertProductionSecrets } = require('../src/config/envGuard.js');

describe('envGuard — insecure production secret detection', () => {
  it('ignores non-production environments (dev/test must not need real secrets)', () => {
    expect(findInsecureProductionSecrets({ NODE_ENV: 'development', ADMIN_KEY: 'changeme' })).toEqual([]);
    expect(findInsecureProductionSecrets({ NODE_ENV: 'test' })).toEqual([]);
    expect(findInsecureProductionSecrets({})).toEqual([]);
  });

  it('flags a missing ADMIN_KEY and ADMIN_SESSION_SECRET in production', () => {
    const problems = findInsecureProductionSecrets({ NODE_ENV: 'production' });
    expect(problems).toContain('ADMIN_KEY');
    expect(problems).toContain('ADMIN_SESSION_SECRET');
    expect(problems).toContain('INTASEND_WEBHOOK_CHALLENGE');
  });

  it('flags the documented placeholder "changeme" in production', () => {
    const problems = findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'changeme',
      ADMIN_SESSION_SECRET: 'changeme',
      INTASEND_WEBHOOK_CHALLENGE: 'changeme',
    });
    expect(problems).toEqual(['ADMIN_KEY', 'ADMIN_SESSION_SECRET', 'INTASEND_WEBHOOK_CHALLENGE']);
  });

  // The webhook guard fails open when the challenge is unset (an absent body
  // `challenge` compares equal to an absent env value), so this must be a hard
  // production requirement independent of the admin secrets.
  it('flags a missing INTASEND_WEBHOOK_CHALLENGE even when the admin secrets are strong', () => {
    const problems = findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'a-long-random-admin-key',
      ADMIN_SESSION_SECRET: 'a-long-random-session-secret',
    });
    expect(problems).toEqual(['INTASEND_WEBHOOK_CHALLENGE']);
  });

  it('passes when strong values are configured in production', () => {
    expect(findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'a-long-random-admin-key',
      ADMIN_SESSION_SECRET: 'a-long-random-session-secret',
      INTASEND_WEBHOOK_CHALLENGE: 'a-long-random-webhook-challenge',
    })).toEqual([]);
  });

  it('assertProductionSecrets invokes the fatal handler with the offending names', () => {
    const onFatal = vi.fn();
    assertProductionSecrets({ NODE_ENV: 'production' }, onFatal);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('ADMIN_SESSION_SECRET');
  });

  it('assertProductionSecrets is a no-op when configuration is safe', () => {
    const onFatal = vi.fn();
    assertProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'strong-key',
      ADMIN_SESSION_SECRET: 'strong-secret',
      INTASEND_WEBHOOK_CHALLENGE: 'strong-challenge',
    }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });
});
