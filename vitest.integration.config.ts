import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.ts'],
    hookTimeout: 45_000,
    testTimeout: 45_000,
    retry: 0,
    sequence: {
      concurrent: false,
    },
  },
});
