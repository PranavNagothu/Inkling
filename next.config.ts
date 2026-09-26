import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded with Node's require instead of bundled: better-sqlite3 is a native addon, pg (Tiger Data
  // / Postgres driver) is on Next's default list anyway, and PGlite ships WASM + data files that
  // must be read from node_modules (DATABASE_URL=pglite:… local runs only; see lib/dbPostgres).
  serverExternalPackages: ["better-sqlite3", "pg", "@electric-sql/pglite"],
};

export default nextConfig;
