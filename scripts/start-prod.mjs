// `npm run start:railway`: the production entry point for a hosted demo (Railway; see docs/railway.md).
// Run after `next build`. It:
//
//   1. makes the data folders on the persistent volume: INKLING_DATA_DIR (e.g. /data) holds the
//      SQLite database, uploads/ (Notability PDFs in uploads/notability) and tts/ (see lib/paths.ts);
//   2. in DEMO_MODE, seeds the demo with `seed:demo` (idempotent: only when it is missing or
//      incomplete, e.g. a fresh volume), or rebuilds it with `--reset` when DEMO_RESET_ON_START=1;
//   3. starts `next start -H 0.0.0.0 -p $PORT`. In DEMO_MODE, DEMO_RESET_MINUTES defaults to 30, so
//      the server resets the demo every 30 minutes (instrumentation.ts → lib/demoReset.ts).
//
// It never prints secrets: only which storage is used and the reset settings.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, NODE_ENV: "production" };
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const setting = (v) => String(v ?? "").trim() || null;
const demo = truthy(env.DEMO_MODE);
const port = setting(env.PORT) ?? "3000";
const host = setting(env.HOST) ?? "0.0.0.0";

// Same defaults as lib/paths.ts (relative paths are resolved against the project root).
const at = (p) => resolve(root, p);
const dataDir = at(setting(env.INKLING_DATA_DIR) ?? "data");
const dbPath = at(setting(env.INKLING_DB_PATH) ?? join(dataDir, "inkling.db"));
const uploadDir = at(setting(env.INKLING_UPLOAD_DIR) ?? join(dataDir, "uploads"));
const ttsDir = at(setting(env.INKLING_TTS_DIR) ?? join(dataDir, "tts"));

const postgres = !!setting(env.DATABASE_URL);
for (const dir of [dataDir, uploadDir, join(uploadDir, "notability"), ttsDir, ...(postgres ? [] : [dirname(dbPath)])]) {
  mkdirSync(dir, { recursive: true });
}
console.log(`▸ Inkling (production) · storage: ${postgres ? "Postgres (DATABASE_URL)" : `SQLite at ${dbPath}`} · files under ${dataDir}`);
if (postgres && demo) {
  console.warn("  DATABASE_URL is set: the demo will use that Postgres database, not the volume. Remove it for SQLite.");
}

if (demo) {
  env.DEMO_RESET_MINUTES = setting(env.DEMO_RESET_MINUTES) ?? "30";
  const reset = truthy(env.DEMO_RESET_ON_START);
  console.log(`▸ DEMO_MODE: seeding the demo${reset ? " (DEMO_RESET_ON_START=1: rebuilding it)" : " if it is missing"}`);
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const seed = spawnSync(
    process.execPath,
    [tsx, "--tsconfig", "scripts/tsconfig.json", "scripts/seed-demo.ts", ...(reset ? ["--reset"] : [])],
    { cwd: root, stdio: "inherit", env },
  );
  if (seed.status !== 0) {
    console.error("✗ Seeding the demo failed; not starting.");
    process.exit(seed.status ?? 1);
  }
  const minutes = Number(env.DEMO_RESET_MINUTES);
  console.log(
    Number.isFinite(minutes) && minutes > 0
      ? `▸ The demo resets every ${env.DEMO_RESET_MINUTES} min (DEMO_RESET_MINUTES; 0 turns it off)`
      : "▸ Periodic demo reset is off (DEMO_RESET_MINUTES=0)",
  );
}

console.log(`▸ next start on ${host}:${port}`);
const next = join(root, "node_modules", "next", "dist", "bin", "next");
const server = spawn(process.execPath, [next, "start", "-H", host, "-p", port], { cwd: root, stdio: "inherit", env });
// Railway stops a deployment with SIGTERM: pass it on so Next shuts down cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (server.exitCode === null) server.kill(signal);
  });
}
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
