// @ts-check
// Minimal lint configuration: ESLint's and typescript-eslint's recommended rules (no type-aware rules: `tsc -b` already
// type-checks strictly) plus the two Rules of Hooks checks. The React Compiler rules of eslint-plugin-react-hooks are
// not enabled because the project does not use the React Compiler.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/', '.unit-tests/']),
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // plain browser script loaded before first paint (public/theme.js)
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { document: 'readonly', localStorage: 'readonly' } },
  },
]);
