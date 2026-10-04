// scripts/audit-institution-refs.js must be read-only by default, require the
// legacy token explicitly, fail safely without a database, and never print the
// connection string or its credentials. The script is run as a real child
// process with an explicit environment (the parent env is not inherited) and a
// scratch working directory, so dotenv (which reads cwd/.env) cannot inject a
// real MONGO_URI.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'audit-institution-refs.js');

// Run the script with the given env in a scratch cwd that has no .env.
function runAudit(env) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gikomart-inst-audit-'));
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      output: `${result.stdout || ''}${result.stderr || ''}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('scripts/audit-institution-refs.js safety', () => {
  it('exits non-zero with no mongodb string when MONGO_URI is unset', () => {
    const result = runAudit({ PATH: '', LEGACY_INSTITUTION_TOKEN: 'example' });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('mongodb');
  });

  it('refuses to run without an explicit legacy token', () => {
    const result = runAudit({ PATH: '', MONGO_URI: 'mongodb://localhost:1/x' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('LEGACY_INSTITUTION_TOKEN');
  });

  it('never prints the URI or its credentials when the database is unreachable', () => {
    const result = runAudit({
      LEGACY_INSTITUTION_TOKEN: 'example',
      MONGO_URI: 'mongodb://fake-user:fake-pass@localhost:1/fakedb',
      PATH: '',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('fake-pass');
    expect(result.output).not.toContain('fake-user');
  });

  it('writes nothing unless --apply is passed, and uses the neutral value', () => {
    const src = readFileSync(scriptPath, 'utf8');
    expect(src).toContain("'--apply'");
    expect(src).toContain('updateMany');
    expect(src).toContain("NEUTRAL_LOCATION = 'Njoro'");
  });

  it('reads the legacy name from the environment (no hardcoded institution) and logs nothing sensitive', () => {
    const src = readFileSync(scriptPath, 'utf8');
    // The match token must be injected, never baked into the source.
    expect(src).toContain('LEGACY_INSTITUTION_TOKEN');
    expect(/console\.log\([^\n]*\buri\b/.test(src)).toBe(false);
    expect(/console\.(?:log|error)\([^\n]*process\.env\b/.test(src)).toBe(false);
  });
});
