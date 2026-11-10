import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Pick up TEST_DATABASE_URL from .env so a fresh terminal works without `export`.
// Only that one key is read: the rest of .env (tokens, EXECUTOR_MODE...) must not leak into tests.
if (!process.env.TEST_DATABASE_URL) {
  try {
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*TEST_DATABASE_URL\s*=/.test(l));
    if (line) {
      process.env.TEST_DATABASE_URL = line
        .slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* no .env: fall back to the default in tests/setup.ts */
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    // All integration tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
