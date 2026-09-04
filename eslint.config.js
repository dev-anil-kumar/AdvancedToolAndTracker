/**
 * Lint config. The point of this file is `no-undef`: with no bundler to catch
 * a missing import, an undefined identifier is a runtime crash in the browser.
 */
import globals from 'globals';

export default [
  {
    files: ['assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        /* Pinned CDN libraries, loaded as classic scripts by index.html. */
        marked: 'readonly',
        DOMPurify: 'readonly',
        hljs: 'readonly',
        /* Fetched on demand by features/convert, not by index.html. */
        pdfjsLib: 'readonly',
        XLSX: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-shadow-restricted-names': 'error',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn'
    }
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-undef': 'error' }
  }
];
