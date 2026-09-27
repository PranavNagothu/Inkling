import type { NextConfig } from "next";

/**
 * Site-wide security headers (from the marketing site, which now lives at /welcome). Safe for the
 * app too: it embeds nothing in frames and never asks for the camera or location. The microphone
 * is allowed for this origin only (never for frames or other origins): Live lecture mode asks for
 * it, and only after the student presses Start.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
];

// One site: the marketing page at /welcome (app/(marketing)) and the app at /app, /session/…,
// /review/… (app/(product)), each with its own root layout. / sends visitors to /welcome.
const nextConfig: NextConfig = {
  // Build output folder. `.next` by default; e2e and preview servers pass INKLING_DIST_DIR so a
  // second `next dev` can run next to the everyday one (Next locks `<distDir>/dev` per server).
  distDir: process.env.INKLING_DIST_DIR || ".next",
  // Vercel (scripts/vercel-build.mjs): a self-contained server in .next/standalone, deployed as ONE
  // Vercel function so pages and API routes share the same instance (and its /tmp SQLite demo).
  ...(process.env.INKLING_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Loaded with Node's require instead of bundled: better-sqlite3 is a native addon, pg (Tiger Data
  // / Postgres driver) is on Next's default list anyway, and PGlite ships WASM + data files that
  // must be read from node_modules (DATABASE_URL=pglite:… local runs only; see lib/dbPostgres).
  serverExternalPackages: ["better-sqlite3", "pg", "@electric-sql/pglite"],
  // Files read at runtime through computed paths, which output file tracing can't see (matters on
  // Vercel, where each function only gets its traced files; harmless elsewhere):
  // - better-sqlite3 picks its native addon from prebuilds/<platform>-<arch>.node at runtime. Vercel
  //   functions are linux (x64 by default, arm64 optional) glibc; the addon is N-API (Node >= 22.14).
  // - the demo lecture's audio, streamed with Range support by the media route from public/demo.
  // Route keys are picomatch globs matched anywhere in the route (`contains`), so "/*" is every route.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/better-sqlite3/prebuilds/linux-x64.node", "./node_modules/better-sqlite3/prebuilds/linux-arm64.node"],
    "/api/lectures/*/media": ["./public/demo/lecture.wav"],
  },
  // The landing page's images are pre-sized static files; no optimizer needed.
  images: { unoptimized: true },
  poweredByHeader: false,
  // Two root layouts and no top-level one: unmatched URLs get app/global-not-found.tsx.
  experimental: { globalNotFound: true },
  async redirects() {
    // Temporary (307): / may become the app's own home later.
    return [{ source: "/", destination: "/welcome", permanent: false }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
