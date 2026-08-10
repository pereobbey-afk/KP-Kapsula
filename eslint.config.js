import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'dist-web/**', 'node_modules/**', 'data/**', 'storage/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        localStorage: 'readonly',
        window: 'readonly',
        document: 'readonly',
        Response: 'readonly',
        RequestInit: 'readonly',
        File: 'readonly',
        FileList: 'readonly',
        Blob: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        HTMLInputElement: 'readonly',
        Intl: 'readonly',
        NodeJS: 'readonly',
        React: 'readonly',
        JSX: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Неиспользуемые переменные — ошибка, кроме префикса _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // any допускается только осознанно
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off', // проверяется TypeScript
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // В CLI-скриптах вывод в консоль — это и есть интерфейс.
    files: ['**/*-cli.ts', 'src/server/main.ts', 'src/worker/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
