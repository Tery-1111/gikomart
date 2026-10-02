import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findInsecureProductionSecrets, assertProductionSecrets, assertStartupConfig } = require('../src/config/envGuard.js');

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
      ADMIN_KEY: 'strong-admin-key-123456',
      ADMIN_SESSION_SECRET: 'strong-session-secret-1234',
      INTASEND_WEBHOOK_CHALLENGE: 'strong-challenge',
    }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('envGuard — minimum secret length (16)', () => {
  const STRONG_SESSION = 'a-long-random-session-secret';
  const STRONG_CHALLENGE = 'a-long-random-webhook-challenge';

  it('flags a too-short non-default ADMIN_KEY in production', () => {
    const problems = findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: 'short',
      ADMIN_SESSION_SECRET: STRONG_SESSION,
      INTASEND_WEBHOOK_CHALLENGE: STRONG_CHALLENGE,
    });
    expect(problems).toEqual(['ADMIN_KEY']);
  });

  it('accepts a 16-character ADMIN_KEY', () => {
    const problems = findInsecureProductionSecrets({
      NODE_ENV: 'production',
      ADMIN_KEY: '0123456789abcdef', // exactly 16
      ADMIN_SESSION_SECRET: STRONG_SESSION,
      INTASEND_WEBHOOK_CHALLENGE: STRONG_CHALLENGE,
    });
    expect(problems).toEqual([]);
  });
});

describe('envGuard — assertStartupConfig (fail fast on missing MONGO_URI)', () => {
  it('calls onFatal with a message naming MONGO_URI when it is missing', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'production' }, onFatal);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('MONGO_URI');
  });

  it('is a no-op under NODE_ENV=test', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'test' }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('envGuard — assertStartupConfig requires BLOCK_HASH_SECRET in production', () => {
  it('calls onFatal naming BLOCK_HASH_SECRET when it is missing in production', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'production', MONGO_URI: 'x' }, onFatal);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('BLOCK_HASH_SECRET');
  });

  it('calls onFatal when the secret is shorter than 16 characters', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'production', MONGO_URI: 'x', BLOCK_HASH_SECRET: 'short-secret-15' }, onFatal);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('BLOCK_HASH_SECRET');
  });

  it('does not call onFatal when a 16-character secret is set', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'production', MONGO_URI: 'x', BLOCK_HASH_SECRET: '0123456789abcdef' }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('calls onFatal exactly once naming both MONGO_URI and BLOCK_HASH_SECRET', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'production' }, onFatal);
    expect(onFatal).toHaveBeenCalledTimes(1);
    const message = onFatal.mock.calls[0][0];
    expect(message).toContain('MONGO_URI');
    expect(message).toContain('BLOCK_HASH_SECRET');
  });

  it('does not require BLOCK_HASH_SECRET under NODE_ENV=test', () => {
    const onFatal = vi.fn();
    assertStartupConfig({ NODE_ENV: 'test' }, onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });
});
