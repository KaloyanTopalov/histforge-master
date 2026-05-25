import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    // Multiple test files spawn real ffmpeg processes (concat / loop / mux /
    // step-09). Running too many in parallel saturates CPU and starves the
    // poll-loop tests (step 03/04) past their 5 s default timeout. Cap to 4
    // forks so concurrent ffmpegs stay reasonable on dev hardware.
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
