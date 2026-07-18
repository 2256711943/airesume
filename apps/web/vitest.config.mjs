import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./.vitest-run', import.meta.url)),
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    environment: 'node',
    include: ['**/*.test.js'],
    pool: 'threads',
  },
});
