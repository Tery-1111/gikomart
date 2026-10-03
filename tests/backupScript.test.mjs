// Phase 8b Step 3 — scripts/backup.js must fail safely and never print the
// connection string or its credentials, and the backups/ directory it writes to
// must be ignored by git. The script is run as a real child process with an
// explicit environment (the parent env is not inherited) and a scratch working
// directory, so dotenv (which reads cwd/.env) cannot inject a real MONGO_URI.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'backup.js');

// Run the script with the given env in a scratch cwd that has no .env.
function runBackup(env) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gikomart-backup-'));
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: scratch,
      env,
      encoding: 'utf8',
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

describe('scripts/backup.js safety (Phase 8b Step 3)', () => {
  it('exits non-zero with no mongodb string when MONGO_URI is unset', () => {
    const result = runBackup({ PATH: '' });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('mongodb');
  });

  it('never prints the URI or its credentials when mongodump is missing', () => {
    const result = runBackup({
      MONGO_URI: 'mongodb://fake-user:fake-pass@localhost:1/fakedb',
      PATH: '',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('fake-pass');
    expect(result.output).not.toContain('fake-user');
  });

  it('the backups/ directory is ignored by git', () => {
    const result = spawnSync('git', ['check-ignore', '-q', 'backups/'], { cwd: repoRoot });
    expect(result.status).toBe(0);
  });

  it('the script source does not log the URI variable or the whole process.env', () => {
    const src = readFileSync(scriptPath, 'utf8');
    // The variable holding the connection string is `uri`.
    expect(/console\.log\([^\n]*\buri\b/.test(src)).toBe(false);
    expect(/console\.(?:log|error)\([^\n]*process\.env\b/.test(src)).toBe(false);
  });
});
