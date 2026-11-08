import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/redis/**/*.integration.ts'],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    retry: 0,
    sequence: {
      concurrent: false,
    },
  },
});
