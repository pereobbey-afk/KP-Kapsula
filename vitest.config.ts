import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Интеграционные тесты поднимают сервер и воркер — нужен запас времени.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
