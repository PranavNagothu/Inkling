// Warm up the dev server so the first test isn't charged for route compilation.
export default async function globalSetup() {
  const base = "http://localhost:3100";
  for (const path of ["/", "/api/sessions", "/api/lectures", "/lectures/new"]) {
    try {
      await fetch(base + path);
    } catch {
      // Server may not be reachable yet in exotic setups; tests will surface real failures.
    }
  }
}
