// Runs once when a Next.js server starts, before it serves requests (node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/instrumentation.md).
//
// - On Vercel (VERCEL=1, DEMO_MODE=1, no DATABASE_URL): seeds the demo into this function instance's
//   throwaway SQLite database under /tmp/inkling before the first request (lib/vercelDemo).
// - Elsewhere, the public demo (DEMO_MODE=1 with DEMO_RESET_MINUTES set; scripts/start-prod.mjs sets
//   30) resets itself periodically in this process: see lib/demoReset. Off on Vercel.
// Everything else is untouched, and the modules are only loaded when needed.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const demo = /^(1|true|yes|on)$/i.test(process.env.DEMO_MODE?.trim() ?? "");
  if (!demo) return;
  if (/^(1|true)$/i.test(process.env.VERCEL?.trim() ?? "")) {
    const { ensureVercelDemo } = await import("./lib/vercelDemo");
    await ensureVercelDemo();
    return;
  }
  if (!process.env.DEMO_RESET_MINUTES?.trim()) return;
  const { startDemoResetTimer } = await import("./lib/demoReset");
  startDemoResetTimer();
}
