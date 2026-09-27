import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Unit tests only; Playwright specs in e2e/ run via `npm run test:e2e`.
export default defineConfig({
  resolve: {
    alias: {
      // `server-only` is provided by Next.js' bundler; under vitest it is a no-op marker.
      'server-only': fileURLToPath(new URL('./lib/__tests__/server-only.stub.ts', import.meta.url)),
      '@/': root,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['lib/**/*.test.ts'],
          // Never let a developer's DATABASE_URL (e.g. a Tiger Cloud service) point tests at real data:
          // getDb() stays on throwaway SQLite files here.
          env: { DATABASE_URL: '' },
        },
      },
      {
        // The integration suites that go through getDb() again, on the Postgres repository
        // (embedded PGlite: the non-Timescale path) — same assertions as on SQLite.
        extends: true,
        test: {
          name: 'postgres',
          include: [
            'lib/__tests__/analyze.test.ts',
            'lib/__tests__/gaps.test.ts',
            'lib/__tests__/lecture.test.ts',
            'lib/__tests__/notabilityDb.test.ts',
            'lib/__tests__/ai-service.test.ts',
            'lib/__tests__/ai-i18n-service.test.ts',
            'lib/__tests__/demoSeed.test.ts',
            'lib/__tests__/liveRoutes.test.ts',
          ],
          env: { DATABASE_URL: 'pglite:memory' },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
