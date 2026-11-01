import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Runs the real syncwave-capture.exe against this PC's audio stack (Windows only).
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/native/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false
  }
})
