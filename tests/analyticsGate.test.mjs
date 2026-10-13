// Loader-gating contract for the REAL analytics.js (PostHog EU).
//
// Contract tests/analyticsContract.test.mjs stubs window.posthog and only
// exercises capture(); this suite exercises the door itself — the IIFE at the
// bottom of analytics.js that decides whether the PostHog snippet runs:
//     ANALYTICS_ENABLED === true && token !== placeholder && !isLocalHost()
// It is tested with the REAL source file on disk (the same file that ships),
// evaluated in a vm sandbox per case. Variant cases are produced by string-
// substituting constants in that real source (never by duplicating gate
// logic), mirroring exactly what an activation/revert edit does to the file.
// No HTTP client exists in the sandbox: the captured script element is never
// executed, so no request can leave the process.
//
// Secrets: analytics.js on an activated tree contains a public PostHog
// ingestion (phc_) token. This test reads it at runtime and only asserts
// shape/consistency — the value itself is never hard-coded here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, '..', 'public', 'assets', 'js', 'analytics.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const PLACEHOLDER = 'phc_REPLACE_WITH_EU_PROJECT_TOKEN';

const tokenInFile = /const POSTHOG_TOKEN = '([^']*)'/.exec(SOURCE)[1];
const enabledAsShipped = /const ANALYTICS_ENABLED = (true|false)/.exec(SOURCE)[1] === 'true';

function variantSource({ enabled, token }) {
  let s = SOURCE;
  s = s.replace(/const ANALYTICS_ENABLED = (true|false)/, `const ANALYTICS_ENABLED = ${enabled}`);
  s = s.replace(/const POSTHOG_TOKEN = '[^']*'/, `const POSTHOG_TOKEN = '${token}'`);
  return s;
}

// Evaluate one variant in a sandbox and record what the loader try-block does.
function loadVariant(source, hostname) {
  const recorded = { scriptSrcs: [] };
  const headStub = {
    insertBefore(el) { recorded.scriptSrcs.push(el.src); },
  };
  const document = {
    createElement() { return { type: '', crossOrigin: '', async: false, src: '' }; },
    getElementsByTagName() { return [{ parentNode: headStub }]; },
  };
  const window = { location: { hostname }, posthog: undefined };
  vm.runInNewContext(source, { window, document });
  return { recorded, window };
}

describe('analytics.js loader gate (real source, vm sandbox, offline)', () => {
  it('activated config (enabled + non-placeholder EU token + remote host) initializes PostHog exactly once through the official snippet', () => {
    const { recorded, window } = loadVariant(
      variantSource({ enabled: true, token: tokenInFile }),
      'gikomart.onrender.com',
    );
    expect(tokenInFile).not.toBe(PLACEHOLDER); // shipped file must not be the placeholder
    expect(window.posthog.__SV).toBe(1);
    expect(window.posthog._i).toHaveLength(1);
    const [initToken, config] = window.posthog._i[0];
    expect(initToken).toBe(tokenInFile);
    expect(config.api_host).toBe('https://eu.i.posthog.com');
    expect(config.person_profiles).toBe('never');
    expect(config.autocapture).toBe(false);
    expect(typeof config.before_send).toBe('function');
    // The snippet must arm the SDK asset URL from the EU asset host; the stub
    // never executes it, so nothing is fetched.
    expect(recorded.scriptSrcs).toHaveLength(1);
    expect(recorded.scriptSrcs[0]).toContain('https://eu-assets.i.posthog.com/static/');
  });

  it('as-shipped file (untouched source string) behaves exactly like the activation gate', () => {
    // Self-consistency guard: if the shipped constants ever drift from
    // "enabled + real token", the suite above must not silently pass.
    expect(enabledAsShipped).toBe(true);
    expect(tokenInFile).not.toBe(PLACEHOLDER);
  });

  it('disabled flag (simulated revert of the activation line) does not initialize', () => {
    const { recorded, window } = loadVariant(
      variantSource({ enabled: false, token: tokenInFile }),
      'gikomart.onrender.com',
    );
    expect(window.posthog).toBeUndefined();
    expect(recorded.scriptSrcs).toHaveLength(0);
  });

  it('placeholder token with enabled=true does not initialize', () => {
    const { recorded, window } = loadVariant(
      variantSource({ enabled: true, token: PLACEHOLDER }),
      'gikomart.onrender.com',
    );
    expect(window.posthog).toBeUndefined();
    expect(recorded.scriptSrcs).toHaveLength(0);
  });

  it('localhost host with enabled=true and a ready token does not initialize', () => {
    const { recorded, window } = loadVariant(
      variantSource({ enabled: true, token: tokenInFile }),
      'localhost',
    );
    expect(window.posthog).toBeUndefined();
    expect(recorded.scriptSrcs).toHaveLength(0);
  });
});
