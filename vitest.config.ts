import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    pool: 'threads',
    maxWorkers: 1,
    testTimeout: 5_000,
    hookTimeout: 10_000,
  },
})
