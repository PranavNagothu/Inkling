// `npm run demo`: the offline demo. Seeds the demo (idempotent), builds for production when the
// build is missing or older than the source, then serves it with `next start` and DEMO_MODE=1 on
// 0.0.0.0:3000 so an iPad on the same Wi-Fi can open it. Prints the LAN URL(s).
//
// Nothing here — or in the running app — needs the network: DEMO_MODE serves the bundled AI
// fixtures, fonts are self-hosted by next/font at build time, and the pdf.js worker is bundled.
// Build once while online (next/font downloads the fonts during `next build`), then demo anywhere.
//
// Options (after `--`, e.g. `npm run demo -- --no-build`):
//   --port <n>     port (default 3000)
//   --host <h>     interface to bind (default 0.0.0.0: reachable from other devices)
//   --reset        rebuild the demo sessions before starting (after a rehearsal)
//   --no-seed      don't seed
//   --build        always rebuild; --no-build never rebuilds
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = option("--port", process.env.PORT || "3000");
const host = option("--host", "0.0.0.0");
const env = { ...process.env, DEMO_MODE: process.env.DEMO_MODE || "1" };
const bin = (name) => join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

function run(label, cmd, cmdArgs, extraEnv = {}) {
  console.log(`\n▸ ${label}`);
  const res = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env: { ...env, ...extraEnv } });
  if (res.status !== 0) {
    console.error(`✗ ${label} failed`);
    process.exit(res.status ?? 1);
  }
}

/** Newest modification time under the folders that make up the production build. */
function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__tests__" || entry.name === "node_modules") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const dir of ["app", "components", "lib", "public"]) if (existsSync(join(root, dir))) walk(join(root, dir));
  for (const file of ["package.json", "next.config.ts", "postcss.config.mjs"]) {
    if (existsSync(join(root, file))) newest = Math.max(newest, statSync(join(root, file)).mtimeMs);
  }
  return newest;
}

function needsBuild() {
  if (flag("--build")) return true;
  if (flag("--no-build")) return false;
  // next.config.ts builds into INKLING_DIST_DIR when set (e2e/preview servers), else .next.
  const buildId = join(root, process.env.INKLING_DIST_DIR || ".next", "BUILD_ID");
  return !existsSync(buildId) || statSync(buildId).mtimeMs < newestSource();
}

function lanUrls() {
  const urls = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${port}`);
  }
  return urls;
}

if (!flag("--no-seed")) run(flag("--reset") ? "Seeding the demo (reset)" : "Seeding the demo", bin("tsx"), ["--tsconfig", "scripts/tsconfig.json", "scripts/seed-demo.ts", ...(flag("--reset") ? ["--reset"] : [])]);
if (needsBuild()) run("Building for production (next build)", bin("next"), ["build"], { NODE_ENV: "production" });
else console.log("\n▸ Production build is up to date (use --build to force a rebuild)");

console.log(`\n▸ Starting Inkling in DEMO_MODE on ${host}:${port}`);
console.log(`  This computer: http://localhost:${port}`);
if (host === "0.0.0.0") {
  const lan = lanUrls();
  if (lan.length) for (const url of lan) console.log(`  iPad (same Wi-Fi): ${url}`);
  else console.log("  No LAN address found — connect to Wi-Fi (or a hotspot) to open it on the iPad.");
}
console.log("  AI: DEMO_MODE fixtures (offline) · Stop: Ctrl+C\n");

const server = spawn(bin("next"), ["start", "-H", host, "-p", port], { cwd: root, stdio: "inherit", env: { ...env, NODE_ENV: "production" } });
const stop = (signal) => {
  if (!server.killed) server.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
