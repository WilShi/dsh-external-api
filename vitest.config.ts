import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    pool: 'threads',
    // The suite binds real loopback ports and rewrites temp files; keep it serial.
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 5_000,
    hookTimeout: 10_000,
  },
})
