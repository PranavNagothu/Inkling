import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
/** The production demo server (`npm run demo` on its own port and database). */
const DEMO_PORT = 3101;
const PG = process.env.INKLING_TEST_PG === "1";

/** No real AI or voices in tests, even if the developer has keys configured. */
const NO_KEYS = {
  OPENAI_API_KEY: "",
  GROQ_API_KEY: "",
  GEMINI_API_KEY: "",
  XAI_API_KEY: "",
  ELEVENLABS_API_KEY: "",
  AI_PREFETCH: "",
};

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [
    // Pre-Phase-5 specs run with AI switched off per request (test-only header, ignored in
    // production builds; see lib/ai/service aiDisabledByRequest), exactly as before AI existed.
    {
      name: "chromium",
      testIgnore: /(phase5|impact|demo|landing)\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], extraHTTPHeaders: { "x-inkling-ai": "off" } },
    },
    // Phase 5 (AI re-teach) and the multilingual re-teach / audio recap (impact) against the
    // deterministic fake provider.
    { name: "ai", testMatch: /(phase5|impact)\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    // Phase 8: the seeded demo, offline, against the production build (next start, DEMO_MODE=1).
    {
      name: "demo",
      testMatch: /demo\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${DEMO_PORT}` },
    },
    // The marketing page (/welcome) and its Ask Inkling assistant, on the same production server.
    // LANDING_AI_DISABLED=1 there: the assistant always answers from the offline FAQ matcher.
    {
      name: "landing",
      testMatch: /landing\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${DEMO_PORT}` },
    },
  ],
  webServer: [
    {
      // The e2e DB and uploads are wiped before the server starts so runs are repeatable.
      // Its own build folder (INKLING_DIST_DIR), so it can run next to an everyday `next dev`.
      command: `node e2e/reset-db.mjs && npm run dev -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        INKLING_DIST_DIR: ".next-e2e",
        INKLING_DB_PATH: "data/e2e.db",
        // SQLite by default, never a DATABASE_URL from .env.local (an empty value blocks it).
        // INKLING_TEST_PG=1 runs the whole suite on the Postgres repository (embedded PGlite).
        DATABASE_URL: PG ? "pglite:data/e2e-pg" : "",
        // Uploaded test lectures go to their own (gitignored) folder, removed before and after runs.
        INKLING_UPLOAD_DIR: "data/e2e-uploads",
        // The deterministic fake provider serves AI requests (AI_PROVIDER=fake never touches the
        // network), network providers and voices are disabled, and Whisper stays off.
        AI_PROVIDER: "fake",
        ...NO_KEYS,
        DEMO_MODE: "",
        INKLING_DISABLE_AI: "1",
        INKLING_TTS_DIR: "data/e2e-tts",
      },
    },
    {
      // `npm run demo` on a fresh database: seed (--reset), build if the source changed, next start.
      command: `node e2e/reset-demo-db.mjs && node scripts/demo.mjs --port ${DEMO_PORT} --host 127.0.0.1 --reset`,
      url: `http://127.0.0.1:${DEMO_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 420_000,
      env: {
        INKLING_DIST_DIR: ".next-e2e-demo",
        INKLING_DB_PATH: "data/e2e-demo.db",
        DATABASE_URL: PG ? "pglite:data/e2e-demo-pg" : "",
        INKLING_UPLOAD_DIR: "data/e2e-demo-uploads",
        INKLING_TTS_DIR: "data/e2e-demo-tts",
        DEMO_MODE: "1",
        AI_PROVIDER: "",
        ...NO_KEYS,
        LANDING_AI_DISABLED: "1",
      },
    },
  ],
});
