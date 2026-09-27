// `npm run seed:demo [-- --reset]`: seeds the polished demo (Maya's two sessions, a Notability
// export, classmates for the class hotspots) into the database the app uses — the local SQLite file
// (INKLING_DB_PATH, default data/inkling.db) or DATABASE_URL (Postgres / Tiger Data). Loads
// .env.local like `next dev`. Idempotent; --reset rebuilds only the demo's own sessions.
// See lib/demoSeed.ts.
import { loadEnvConfig } from "@next/env";

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log("Usage: npm run seed:demo [-- --reset]\n  --reset  delete and rebuild the demo sessions (keeps everything else)");
    return;
  }
  loadEnvConfig(process.cwd());
  // Imported after the environment is loaded (the repository reads DATABASE_URL when first used).
  const { getDb } = await import("../lib/db");
  const { seedDemo } = await import("../lib/demoSeed");
  const { dbPathSetting } = await import("../lib/paths");
  const db = getDb();
  try {
    const info = await db.info();
    const where = info.backend === "sqlite" ? `SQLite (${dbPathSetting()})` : `Postgres${info.timescale ? " + TimescaleDB" : ""}`;
    const result = await seedDemo({ reset: args.has("--reset") });
    const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
    console.log(result.status === "seeded" ? `Seeded the demo into ${where}.` : `The demo is already in ${where} (use --reset to rebuild it).`);
    for (const s of result.sessions) {
      const name = { misconception_corrected: "correction", unresolved_gap: "gap", breakthrough: "breakthrough" } as const;
      const moments = s.moments.map((m) => `${name[m.type]} @ ${clock(m.lectureMs)} (${m.status})`);
      console.log(`  ${s.title}: ${moments.length ? moments.join(", ") : "no moments (calm writing)"}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("seed:demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
