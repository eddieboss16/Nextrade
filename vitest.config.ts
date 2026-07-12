import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // pglite boots an in-process WASM Postgres; that boot is slow and variable
    // in constrained environments, so give the beforeAll hook generous headroom.
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
