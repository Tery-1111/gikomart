const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Global ignores (must be a standalone object to apply everywhere)
  { ignores: ['node_modules/**', 'logs/**', 'dist/**', 'public/ui-preview/**', '.claude/**', '.playwright-mcp/**'] },

  js.configs.recommended,

  // Backend: CommonJS + Node globals
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|next', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'smart'],
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
