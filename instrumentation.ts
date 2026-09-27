// Runs once when a Next.js server starts, before it serves requests (node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/instrumentation.md).
//
// The public demo (DEMO_MODE=1 with DEMO_RESET_MINUTES set; scripts/start-prod.mjs sets 30) resets
// itself periodically in this process: see lib/demoReset. Everything else is untouched, and the
// module is only loaded when a reset is actually configured.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const demo = /^(1|true|yes|on)$/i.test(process.env.DEMO_MODE?.trim() ?? "");
  if (!demo || !process.env.DEMO_RESET_MINUTES?.trim()) return;
  const { startDemoResetTimer } = await import("./lib/demoReset");
  startDemoResetTimer();
}
