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
  });

  it('flags the documented placeholder "changeme" in production', () => {
    const problems = findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'changeme',
      ADMIN_SESSION_SECRET: 'changeme',
    });
    expect(problems).toEqual(['ADMIN_KEY', 'ADMIN_SESSION_SECRET']);
  });

  it('passes when strong values are configured in production', () => {
    expect(findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'a-long-random-admin-key',
      ADMIN_SESSION_SECRET: 'a-long-random-session-secret',
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
    }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });
});
