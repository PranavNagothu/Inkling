// Warm up the dev server so the first test isn't charged for route compilation.
export default async function globalSetup() {
  const base = `http://localhost:${Number(process.env.E2E_PORT) || 3100}`;
  for (const path of ["/app", "/api/sessions", "/api/lectures", "/lectures/new"]) {
    try {
      await fetch(base + path);
    } catch {
      // Server may not be reachable yet in exotic setups; tests will surface real failures.
    }
  }
}
