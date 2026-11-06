import js from '@eslint/js';
export default [
  { ignores: ['node_modules/**', '.ci-runner-lab/**', 'test-results/**'] },
  js.configs.recommended,
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: {
    process: 'readonly', Buffer: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
    console: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', AbortController: 'readonly',
    structuredClone: 'readonly', performance: 'readonly'
  } }, rules: { 'no-control-regex': 'off', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['tests/*.spec.js', 'src/app.js'], languageOptions: { globals: { document: 'readonly', window: 'readonly', fetch: 'readonly', FormData: 'readonly' } } }
];
