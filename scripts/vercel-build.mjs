// `node scripts/vercel-build.mjs`: the Vercel build (vercel.json buildCommand; see docs/vercel.md).
//
// Why not Vercel's stock Next.js builder: it splits the app into several functions (pages, API
// routes, prerenders), and each runs on its own instances with its own /tmp. The public demo keeps
// its SQLite database in /tmp (lib/paths, lib/vercelDemo), so a session created by POST /api/sessions
// would not exist for the /session/[id] page. Instead this script builds Next's standalone server
// and writes a Build Output API v3 folder (.vercel/output) with:
//
//   static/                   public/ and .next/static (served by Vercel's CDN, Range included)
//   functions/index.func/     ONE Node function: the standalone server (`next start`-equivalent),
//                             which serves every page and API route, redirects and headers
//   config.json               filesystem first, then everything else → index
//
// vercel.json pins the @vercel/static-build builder, which runs `npm run vercel-build` (this script)
// and deploys the .vercel/output it produces as is (instead of re-packaging .next with the stock
// Next.js builder).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, ".next");
const out = join(root, ".vercel", "output");
const func = join(out, "functions", "index.func");
// The function runs on the same Node major as the build (the project's Node.js Version setting).
const NODE_RUNTIME = `nodejs${process.versions.node.split(".")[0]}.x`;

console.log("▸ next build (standalone)");
const build = spawnSync(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, INKLING_STANDALONE: "1", INKLING_DIST_DIR: "" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

const standalone = join(dist, "standalone");
if (!existsSync(join(standalone, ".next", "required-server-files.json"))) {
  console.error("✗ .next/standalone is missing: is `output: \"standalone\"` set for INKLING_STANDALONE=1?");
  process.exit(1);
}

console.log("▸ writing .vercel/output");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "static", "_next"), { recursive: true });

// Static files for the CDN.
cpSync(join(root, "public"), join(out, "static"), { recursive: true });
cpSync(join(dist, "static"), join(out, "static", "_next", "static"), { recursive: true });

// The function: the standalone server plus the files it reads from disk at runtime.
cpSync(standalone, func, { recursive: true, verbatimSymlinks: true });
// The media route streams the demo lecture from public/demo (lib/storage, relative to cwd).
cpSync(join(root, "public", "demo"), join(func, "public", "demo"), { recursive: true });
// better-sqlite3 resolves its addon at runtime by platform (file tracing only sees the build
// machine's): make sure the Linux ones are there.
for (const arch of ["x64", "arm64"]) {
  const rel = join("node_modules", "better-sqlite3", "prebuilds", `linux-${arch}.node`);
  if (existsSync(join(root, rel))) cpSync(join(root, rel), join(func, rel));
}

const { config } = JSON.parse(readFileSync(join(func, ".next", "required-server-files.json"), "utf8"));
// Vercel compresses responses itself.
config.compress = false;
writeFileSync(
  join(func, "___inkling_launcher.cjs"),
  `"use strict";
// Vercel entry point (written by scripts/vercel-build.mjs): Next's own server, as \`next start\` runs
// it, wrapped as a Node request handler. Runs instrumentation.ts (the demo seed) during prepare().
process.chdir(__dirname);
process.env.NODE_ENV = "production";
const conf = ${JSON.stringify(config)};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
const next = require("next");
// The custom-server wrapper (not the bare NextServer) so redirects, headers and rewrites apply too.
const app = next({ dev: false, dir: __dirname, conf, hostname: "localhost", port: 3000 });
const handle = app.getRequestHandler();
const ready = app.prepare();
module.exports = async (req, res) => {
  await ready;
  return handle(req, res);
};
`,
);
writeFileSync(
  join(func, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: NODE_RUNTIME,
      handler: "___inkling_launcher.cjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
      regions: ["iad1"],
    },
    null,
    2,
  ),
);

writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/_next/static/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index" },
      ],
    },
    null,
    2,
  ),
);
console.log("✓ .vercel/output ready (one function: index)");
