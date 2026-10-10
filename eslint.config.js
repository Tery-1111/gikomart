const js = require('@eslint/js');
const globals = require('globals');
const security = require('eslint-plugin-security');

module.exports = [
  // Global ignores (must be a standalone object to apply everywhere)
  { ignores: ['node_modules/**', 'logs/**', 'dist/**', 'public/ui-preview/**', '.claude/**', '.playwright-mcp/**'] },

  js.configs.recommended,

  // Style hardening that applies to every linted file: enforce const when a
  // binding is never reassigned, ban var (function-scoped, hoisting traps),
  // require ===/!== (smart keeps == null comparisons legal), and ban eval /
  // new Function as a baseline hygiene rule.
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-eval': 'error',
    },
  },

  // Backend: CommonJS + Node globals. eslint-plugin-security guards the
  // classic Node attack surface: ReDoS-prone regexes, injection-prone
  // string building, unsafe crypto, fs path traversal, prototype pollution.
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'server.js'],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|next', caughtErrors: 'none', ignoreRestSiblings: true }],
      'security/detect-object-injection': 'off', // false positive on req.body[key] idiom; NoSQL sanitize middleware + Mongoose schemas are the actual guards
      'security/detect-child-process': 'off', // no child processes in this codebase; rule can't tell exec from spawn
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Verification tools (tools/ui-rig): same CommonJS + Node globals and the
  // same security-plugin ruleset as src/ so the rig lints under identical rules.
  {
    files: ['tools/**/*.js'],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|next', caughtErrors: 'none', ignoreRestSiblings: true }],
      'security/detect-object-injection': 'off', // false positive on req.body[key] idiom; NoSQL sanitize middleware + Mongoose schemas are the actual guards
      'security/detect-child-process': 'off', // no child processes in this codebase; rule can't tell exec from spawn
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Standalone ESM verification tools executed inside Node but driving a
  // real browser via playwright-core (tools/responsive-check.mjs): their
  // source speaks in browser-API names (window/document/localStorage/fetch)
  // and runs page.evaluate callbacks, so the BROWSER globals apply — the
  // script's own imports (node:fs, createRequire, path) remain explicit.
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|next', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },

  // Frontend: browser globals for the vanilla-JS app
  {
    files: ['public/assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Tests: ESM + Node globals
  {
    files: ['tests/**/*.mjs', 'vitest.config.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
