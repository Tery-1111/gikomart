import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(here, '../public/legal/prohibited-items.html');

const ALLOWED_PLACEHOLDERS = [
  '[OPERATOR_NAME]', '[OPERATOR_ADDRESS]', '[SUPPORT_EMAIL]', '[SUPPORT_WHATSAPP]', '[EFFECTIVE_DATE]',
];

describe('Prohibited Items page reflects the in-page Report button', () => {
  it('points at the Report button instead of the "until available" wording', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    expect(html).toContain('Use the Report button on any listing or store page');
    expect(html).not.toContain('Until the in-page Report button');
  });

  it('uses only the five allowed placeholders', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    const found = [...new Set([...html.matchAll(/\[[A-Z][A-Z_]+\]/g)].map((m) => m[0]))];
    for (const token of found) {
      expect(ALLOWED_PLACEHOLDERS, token).toContain(token);
    }
  });
});
