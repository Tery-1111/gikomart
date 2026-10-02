import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const staticOptions = require('../src/config/staticOptions');

const app = express();
app.use(express.static('public', staticOptions));

const FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval',
  'new Function',
  'localStorage',
  'sessionStorage',
];

describe('Static asset headers', () => {
  it('serves the admin page with no-store and noindex,nofollow', async () => {
    const res = await request(app).get('/admin/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('serves the admin directory with the same headers', async () => {
    const res = await request(app).get('/admin/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('serves the admin script and stylesheet with the same headers', async () => {
    const js = await request(app).get('/assets/js/admin.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toBe('no-store');
    expect(js.headers['x-robots-tag']).toBe('noindex, nofollow');

    const css = await request(app).get('/assets/css/admin.css');
    expect(css.status).toBe(200);
    expect(css.headers['cache-control']).toBe('no-store');
    expect(css.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('keeps index.html revalidated and carries no X-Robots-Tag', async () => {
    const res = await request(app).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=0');
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  it('keeps public assets cached for a week, not no-store', async () => {
    const js = await request(app).get('/assets/js/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toContain('max-age=604800');
    expect(js.headers['cache-control']).not.toContain('no-store');

    const css = await request(app).get('/assets/css/style.css');
    expect(css.status).toBe(200);
    expect(css.headers['cache-control']).toContain('max-age=604800');
  });
});

describe('Admin portal source hygiene', () => {
  const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('admin/index.html has exactly one script (the external admin.js) and no inline handlers', () => {
    const html = read('public/admin/index.html');
    const scripts = html.match(/<script/gi) || [];
    expect(scripts).toHaveLength(1);
    expect(html).toContain('<script src="/assets/js/admin.js"></script>');
    expect(/\son[a-z]+\s*=/i.test(html)).toBe(false);
    expect(html.includes('style=')).toBe(false);
    expect(/name="robots"\s+content="noindex,nofollow"/.test(html)).toBe(true);
  });

  it('admin.js contains none of the forbidden constructs', () => {
    const js = read('public/assets/js/admin.js');
    for (const word of FORBIDDEN) {
      expect(js.includes(word), `admin.js must not contain "${word}"`).toBe(false);
    }
  });

  it('no public page links to the admin portal', () => {
    const files = ['public/index.html'];
    for (const name of fs.readdirSync('public/legal')) {
      if (name.endsWith('.html')) files.push(path.join('public', 'legal', name));
    }
    for (const file of files) {
      const html = read(file);
      expect(/href\s*=\s*["'][^"']*admin/i.test(html), `${file} must not link to admin`).toBe(false);
    }
  });
});
