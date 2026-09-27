# Inkling deploy plan

> **Superseded (2026-09-27):** the app is deployed on Railway (Dockerfile, SQLite on a `/data` volume, DEMO_MODE with an in-process periodic reset). Follow [`docs/railway.md`](railway.md). The blockers in section 5 (Whisper in DEMO_MODE, open uploads, reset, `sameOriginOnly` behind a proxy) are fixed in code. The research below is kept for reference.

Written 2026-09-26, the night before the deadline. This covers research only; no code has been changed. Line numbers refer to the working tree at the time of writing. Another agent is merging `landing/` into the app, so re-check any reference that sits in `lib/ai/*`, `app/page.tsx` or `next.config.ts` before editing it.

**Target:** one Next 16 app on your own `.tech` domain, with `/welcome` (landing) and `/app` (the app). The public site runs in `DEMO_MODE`. Live AI is shown only on your laptop.

---

## TL;DR

- **Recommendation: Option B, a Vultr VPS with SQLite on disk, `DEMO_MODE=1`, Caddy and systemd (or pm2).**
  - None of the code changes are mandatory. It is the same stack that `npm run demo` and `e2e/demo.spec.ts` already exercise (`next start`, SQLite, DEMO_MODE).
  - It qualifies for the MLH Vultr prize and costs about $10/month, billed hourly, so a few dollars for the weekend.
  - It takes roughly 60–90 minutes, including DNS.
- **Option A, Vercel with Tiger Data and DEMO_MODE, needs at least 4 code changes before the core demo works:**
  - The demo audio is not in the function bundle.
  - Uploads can't work at all.
  - The seeded Notability PDF lives on your laptop's disk.
  - You need a second Tiger service.
- **Blockers that apply to both options.** Fix these whichever option you pick; section 5 has details.
  1. **`DEMO_MODE` does not gate Whisper transcription.** `/api/ask` needs `GROQ_API_KEY`. With that key set, `POST /api/lectures/[id]/transcribe` would spend Groq credits. **Also set `INKLING_DISABLE_AI=1`.**
  2. **Uploads are open to strangers.** A lecture can be up to 300 MB and a Notability PDF up to 50 MB. Uploaded lectures are listed for every visitor, and they can fill the disk. Disable uploads on the public deploy.
  3. **There is no auth.** Every visitor is the same student (`LOCAL_STUDENT_ID`), so anyone can draw into Maya's seeded sessions. Schedule a reset.
  4. **The merge must not add a `proxy.ts` whose matcher covers `/api/*`.** When a proxy exists, Next buffers request bodies to 10 MB (`proxyClientMaxBodySize`) and silently truncates anything larger.

---

## 0. Facts established from the code

### Storage

| Concern | Where | Behaviour |
|---|---|---|
| DB selection | `lib/db.ts:812-822` | `DATABASE_URL` set → Postgres (`lib/dbPostgres.ts`). Unset → SQLite at `INKLING_DB_PATH` (default `data/inkling.db`). |
| better-sqlite3 import | `lib/db.ts:3` (static import) | **Harmless when `DATABASE_URL` is set.** v13 loads the native addon lazily, inside the `Database` constructor (`node_modules/better-sqlite3/lib/binding.js`), and `SqliteDb` is only constructed when `DATABASE_URL` is unset. v13 also *ships* prebuilds for linux-x64/arm64 (glibc and musl), so it needs no compile step on Vercel or Ubuntu. |
| SQLite dir creation | `lib/db.ts:170` `mkdirSync(dirname(file))` | Fails with EROFS on Vercel, because `/var/task` is read-only. |
| ai_cache | `lib/dbPostgres.ts:389`, SQLite equivalent | **In the DB, not on disk.** Fine everywhere. |
| TTS mp3 cache | `lib/ai/service.ts:121` (`INKLING_TTS_DIR`, default `data/tts`), writes at `:404-406` | On disk. **Never reached in DEMO_MODE**, because `lib/ai/tts.ts:39` returns no voice. |
| Lecture uploads | `lib/storage.ts:15` (`INKLING_UPLOAD_DIR`, default `data/uploads`), `app/api/lectures/route.ts:39-115` (writes at `:89-94`) | On disk, up to 300 MB (`lib/upload.ts:5`). |
| Notability PDF import | `app/api/sessions/[id]/notability/route.ts:34`, writes at `:65-68` | On disk, up to 50 MB (`lib/notability.ts:6`). |
| Seeded Notability PDF | `lib/demoSeed.ts:122-124` | `seed:demo` writes the PDF to the **local disk of the machine that runs the seed**. The DB row only stores its name. |
| Media route | `app/api/lectures/[id]/media/route.ts:13-60` | Reads from disk via `resolveMediaPath` (`lib/storage.ts:34-41`). The demo file is `public/demo/lecture.wav` (2.9 MB, `lib/demo.ts:15`), resolved through `process.cwd()` with `turbopackIgnore`, **so file tracing cannot see it**. Range, 206 and ETag are implemented in the route itself. |
| Session PDF export | `app/api/sessions/[id]/export/route.ts` | Built in memory with pdf-lib and returned as bytes. **No filesystem write; fine on serverless.** |
| Pages | `app/page.tsx`, `app/progress`, `app/about`, and others | All dynamic (`connection()` or dynamic params). **Nothing touches the DB at build time.** |

### What `DEMO_MODE` actually does

These are exact code paths, as of `lib/ai/*` at the time of writing.

**Provider selection.** `lib/ai/select.ts:51`: with `DEMO_MODE` truthy (`1|true|yes|on`), the mode is `'demo'` and the provider is `createFakeProvider()`. The fake provider is offline and deterministic (`lib/ai/fake.ts`). This check runs *before* `AI_PROVIDER` and `INKLING_DISABLE_AI`.

**What DEMO_MODE covers, per AI call** (`lib/ai/service.ts`):

- **Help card** (`ensureHelp`, `:240-272`).
  - If the moment's `lectureMs` falls inside a fixture window of `public/demo/ai-cache.json`, the visitor gets the hand-checked card.
  - Otherwise the fake provider generates a card through `cachedCall`. The result is written to the `ai_cache` table and counts against the per-session in-memory rate limit (`AI_RATE_LIMIT`, 30 per 10 minutes).
  - **The fixtures cover the entire demo lecture (0–360 000 ms, 13 windows).** So on the demo lecture, every moment gets a hand-written card.
- **Concept labels** (`:200-235`): the fixture label, otherwise the fake label.
- **Revision reading** (`:341-372`): the fixture reading if that window has one (7 of 13 do). Otherwise the fake reading, e.g. "a first attempt at this step (N KB of ink)".
- **Translations** (`:283-296`): **fixture translations only.** Spanish and Hindi exist for 3 windows. Everything else falls back to English, with `languageFallback`.
- **Recap** (`:424-475`): always the deterministic template in demo mode.
- **Read aloud** (`lib/ai/tts.ts:39`): no server voice, so the browser's `speechSynthesis` is used. Your ElevenLabs key is never used.

**What DEMO_MODE does not cover:**

- **Whisper transcription.** `lib/transcribe.ts:40-41` only checks `INKLING_DISABLE_AI === "1"`, and `lib/lecture.ts:33-35` delegates to it. With `GROQ_API_KEY` or `OPENAI_API_KEY` present, the "Auto-transcribe" button (`components/TranscriptPanel.tsx:73`) calls the network. The About page (`app/about/page.tsx:102`) claims "no network requests", which is wrong in that case.
- **`/api/ask`** (the landing assistant) uses `GROQ_API_KEY` by design. It has its own caps (see section 5).

**The `x-inkling-ai: off` header** (`lib/ai/service.ts:509-527`) can only turn AI *off*, and it is ignored when `NODE_ENV=production`. A visitor cannot use it to turn live AI on.

**A brand-new visitor session in DEMO_MODE:**

1. `POST /api/sessions` defaults to the demo lecture (`app/api/sessions/route.ts:36-37`).
2. Ink autosaves to `/api/sessions/[id]/strokes`.
3. Analysis is deterministic and uses no AI.
4. When the visitor opens a moment, they get the fixture card for **that point in the lecture timeline, not for what they actually wrote.** The revision reading is the fixture one where it exists, and the fake one otherwise.
5. Check questions grade against the fixture `answerIdx`.
6. The recap is the template. Read-aloud uses the browser voice.
7. **Nothing costs money**, as long as transcription is closed off (blocker 1).
8. The visitor's session is visible to every other visitor.

The seed produces Maya's two sessions plus five classmates (`lib/demoScenario.ts:19-25`). It is idempotent. `--reset` deletes and rebuilds *only* those sessions (`lib/demoSeed.ts:42-67`) and leaves visitor sessions in place.

### The landing assistant: `/api/ask` (`landing/app/api/ask/route.ts`)

- It uses `GROQ_API_KEY` (server-only), `LANDING_AI_MODEL`, `LANDING_AI_DAILY_CAP` (default 500) and `LANDING_AI_DISABLED=1`.
- Its limits are in memory (`:28-34`):
  - model calls: 10 per minute and 60 per day per IP, plus a global daily cap
  - every request: 30 per minute and 400 per day per IP
  - past the model limits it falls back to offline answers
- **On Vercel these counters are per instance** (approximate). On a single VPS process they are exact.
- `clientIp` (`landing/lib/ask/origin.ts:29-31`) trusts the first `X-Forwarded-For` hop. That is safe behind Vercel and Caddy, because both set XFF from the real peer. It is **not** safe with the Node port exposed directly, so bind Next to 127.0.0.1.

---

## 1. Option A: Vercel + Tiger Data Postgres + DEMO_MODE

### What breaks, and why

| # | Problem | Severity |
|---|---|---|
| A1 | **Demo audio 404s.** `public/` is served by the CDN and is not in the function bundle. The media route reads `public/demo/lecture.wav` from `process.cwd()` (`lib/storage.ts:12,37`), and `turbopackIgnore` hides the path from tracing. Result: no playback on the session and review pages. | Blocker |
| A2 | **SQLite can't be used.** `/var/task` is read-only (`lib/db.ts:170`), and `/tmp` is per instance and ephemeral, so sessions would vanish or 404 across instances. **`DATABASE_URL` is required.** Once it is set, the SQLite import is harmless (addon loaded lazily). | Blocker (config) |
| A3 | **Uploads fail.** Vercel Functions cap request bodies at **4.5 MB**, and the upload directory is read-only (`lib/storage.ts:15,22`, `app/api/lectures/route.ts:89`). `INKLING_UPLOAD_DIR=/tmp/...` would work only on one instance until it recycles. | Blocker for the upload feature; disable it |
| A4 | **The seeded Notability PDF 404s.** `seed:demo` run from your laptop writes the file to *your laptop* (`lib/demoSeed.ts:124`). `/api/sessions/demo-maya-1/notability/file` (`app/api/sessions/[id]/notability/file/route.ts:16-26`) then can't find it on Vercel, so the compare page loses the PDF pane. | Blocker for the compare page |
| A5 | **Notability PDF import** (`app/api/sessions/[id]/notability/route.ts:34-68`): disk write plus a body that can exceed 4.5 MB. | Disable |
| A6 | **The TTS disk cache** (`lib/ai/service.ts:121`) is never used in DEMO_MODE. Only relevant if you ever run live AI on Vercel; then set `INKLING_TTS_DIR=/tmp/inkling-tts`. | None in demo |
| A7 | **Connection pool.** `lib/dbPostgres.ts:186-195` uses `max: 5` per instance, and every Fluid-compute instance keeps its own pool. Set `PG_POOL_MAX=2`. Use the **direct** Tiger endpoint, not its PgBouncer pooler: the pool sends `statement_timeout` as a startup parameter (`:192`), which transaction poolers often reject. Each cold start re-runs migrate plus the Timescale setup (`:540-575`). This is idempotent and takes an advisory lock, but adds some latency. | Config |
| A8 | **Timeouts.** No route in DEMO_MODE is long-running: analyze, export and evaluation are CPU-only and take seconds. Vercel's default max duration with Fluid compute is well above that. Only live Whisper would be long, and it is disabled. No `maxDuration` is needed. | OK |
| A9 | **Body limits.** The largest legitimate non-upload body is the strokes batch, `MAX_STROKES_BODY_BYTES` = 4 MB (`lib/autosave.ts:14`), which is under 4.5 MB. Read-revision is about 550 KB. | OK |
| A10 | **Git deploy.** Vercel builds from GitHub. `landing/` is **untracked** (0 files in git), and the working tree has many uncommitted changes. Everything must be merged, committed and pushed first. | Process |
| A11 | **Bundle size.** `serverExternalPackages` (`next.config.ts:7`) plus the dynamic `import("@electric-sql/pglite")` (`lib/dbPostgres.ts:245`) means pglite (25 MB) and better-sqlite3 (26 MB) get traced into DB routes. This is under the 250 MB limit, so it's optional to trim. | Minor |

### Exact code changes for Option A

1. **`next.config.ts`** (currently lines 3-8). Add the demo audio to the media route's trace, plus security headers:
   ```ts
   outputFileTracingIncludes: {
     "/api/lectures/[id]/media": ["./public/demo/lecture.wav"],
   },
   poweredByHeader: false,
   async headers() { return [{ source: "/:path*", headers: securityHeaders }]; }, // copy landing/next.config.ts:33-38
   ```
   Alternative: in `app/api/lectures/[id]/media/route.ts:16`, return `Response.redirect(new URL("/demo/lecture.wav", request.url), 307)` when `record.mediaPath === DEMO_MEDIA_PATH`. The CDN serves that file with Range support.
2. **Disable uploads in public mode.** Add a helper such as `export const uploadsDisabled = () => truthy(process.env.DEMO_MODE) || process.env.INKLING_DISABLE_UPLOADS === "1"` and use it:
   - Return 403 at the top of `app/api/lectures/route.ts:39` (the POST).
   - Return 403 at the top of `app/api/sessions/[id]/notability/route.ts:34` (the POST).
   - Hide the "Add lecture" link (`app/page.tsx`, the `add-lecture` link; its line is shifting during the merge) and `app/lectures/new/page.tsx`, plus the Notability upload control on the compare page.
3. **Serve the seeded Notability PDF without the laptop's disk.** Pick one:
   - (a) In `app/api/sessions/[id]/notability/file/route.ts:16-26`: when the file is missing and `id === DEMO_SESSIONS.s1.id`, render it on the fly with `renderFinalPagePdf(await db.getStrokes(id), { title: "Chain rule — Maya" })` (`lib/demoPdf.ts:22`). This is pure JS and works on serverless.
   - (b) Commit a fixed `public/demo/notability.pdf`, let `resolvePdfPath` (`lib/storage.ts:57-62`) accept it, and add it to `outputFileTracingIncludes` for that route.
4. **Close the transcription hole in code.** In `lib/transcribe.ts:41`, change the check to `if (env.INKLING_DISABLE_AI === "1" || /^(1|true|yes|on)$/i.test(env.DEMO_MODE?.trim() ?? "")) return null;`. The env-only alternative is `INKLING_DISABLE_AI=1`.
5. **Optional: fail loudly on Vercel without a DB.** In `lib/db.ts:815`, add `if (!url && process.env.VERCEL) throw new Error("DATABASE_URL is required on Vercel");`.
6. **Optional: protect the seeded sessions.** In DEMO_MODE, return 403 for writes to `demo-maya-*` and `demo-classmate-*` IDs in `app/api/sessions/[id]/strokes/route.ts:9`. Otherwise, schedule a reseed (see section 5).
7. **Optional: trim the bundle.** `outputFileTracingExcludes: { "/*": ["./node_modules/@electric-sql/pglite/**"] }`.

### Env vars for Vercel (Production scope)

| Var | Value | Why |
|---|---|---|
| `DATABASE_URL` | **The prod Tiger service**, `?sslmode=require` | Required (A2). Never the dev URL. |
| `PG_POOL_MAX` | `2` | A7 |
| `DEMO_MODE` | `1` | Fixtures only |
| `INKLING_DISABLE_AI` | `1` | Kills Whisper transcription and server TTS. Demo fixtures still work, because `select.ts:51` checks DEMO_MODE first. Must be exactly `1` (`lib/transcribe.ts:41`). |
| `GROQ_API_KEY` | your key | `/api/ask` only |
| `LANDING_AI_DAILY_CAP` | e.g. `200` | Cost ceiling per instance |
| `NEXT_PUBLIC_SITE_URL` | `https://<your>.tech` | OG URLs (`landing/app/layout.tsx:21`). Inlined at build time. |
| **Do not set** | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `ELEVENLABS_API_KEY` | Not needed in demo mode. Leaving them out removes any chance of spend. |

Set everything in the Vercel dashboard (Project → Settings → Environment Variables). Nothing goes in git.

### Postgres questions

- **Can DEMO_MODE use Postgres?** Yes. DEMO_MODE only affects AI selection (`lib/ai/select.ts:51`, `lib/ai/tts.ts:39`, the About page). Storage is chosen independently (`lib/db.ts:812-822`). Fake-provider results go into the `ai_cache` table, keyed by provider `fake`, so they never collide with live entries.
- **Does `seed:demo` work against Postgres?** Yes. `scripts/seed-demo.ts` uses `getDb()`, and after seeding it refreshes the Timescale continuous aggregate (`lib/demoSeed.ts:137-138`). Two caveats:
  - It writes the Notability PDF to the local disk (A4).
  - `loadEnvConfig` runs in *production* mode (`scripts/seed-demo.ts:14`), so it reads `.env.production.local` **before** `.env.local`. Don't create a `.env.production.local` on your laptop that holds the prod URL, or every later seed will silently hit prod. Instead, put the URL in a file Next never auto-loads and source it for one command:
    ```bash
    # ~/.inkling-prod.env (chmod 600) contains: DATABASE_URL=postgres://...prod...?sslmode=require
    ( set -a; . ~/.inkling-prod.env; set +a; npm run seed:demo -- --reset )
    ```
    Variables already in the shell win over env files, because `@next/env` never overrides existing values.
- **Keep prod separate from dev.** Your laptop's `.env.local` has `DATABASE_URL` set, pointing at the Tiger service that holds your practice sessions.
  - All sessions share one student ID, and there is no auth. If prod pointed at the same database, strangers would see (and could draw into) your practice sessions, and your laptop would list theirs.
  - **Preferred:** a second Tiger service (e.g. `inkling-prod`) with its own URL. Check the free-plan service count in the Tiger console.
  - **Fallback: a schema in the same service.**
    1. Run `CREATE SCHEMA inkling_prod;` once.
    2. Append `&options=-c%20search_path%3Dinkling_prod%2Cpublic` to the URL. node-postgres passes `options` through as a startup parameter.
    3. `public` must stay on the path, because the TimescaleDB functions (`time_bucket`, `create_hypertable`) live there.
    4. Check `/api/health` → `{ backend: "postgres", timescale: true }`.
  - Region: put Vercel functions in `iad1` (Washington DC) if the Tiger service is in AWS us-east-1.

**Option A effort:** about 2–3 hours of code, test and deploy, on top of finishing the merge.

---

## 2. Option B: Vultr VPS runbook (Ubuntu 24.04, Node 22, Caddy, SQLite, DEMO_MODE)

**Cost:**

- 1 vCPU / 2 GB / ~55 GB SSD "Cloud Compute – Regular" is about **$10/month**; the 1 GB plan is about $5/month. Verify on vultr.com/pricing.
- Billing is hourly, so a weekend costs about $1. Destroy the instance afterwards, or keep it through judging.
- Use the MLH Vultr credit link if your event provides one.
- `next build` with Turbopack is memory-hungry. Use 2 GB, or 1 GB plus a 2 GB swap file.
- Choose the **Atlanta (ATL)** region for the lowest latency at HackGT.

**Why no code changes are required:** persistent disk means SQLite, uploads, the seeded PDF and the demo WAV all work exactly as they do locally. A single process means the in-memory rate limits are exact. Still apply blockers 1–3 from section 5. Blocker 1 needs only env vars; blocker 2 is one guard or a Caddy body cap.

### Steps

1. **Create the server.** Vultr → Deploy → Cloud Compute (Shared CPU), Regular, ATL, Ubuntu 24.04 LTS x64, 2 GB. Add your SSH public key. IPv6 is optional. Note the IPv4 address.

2. **DNS.** Create the records from section 3 now, so they propagate while you set up.

3. **Base setup** (as root):
   ```bash
   adduser --disabled-password --gecos "" deploy && usermod -aG sudo deploy
   rsync -a ~/.ssh /home/deploy/ && chown -R deploy:deploy /home/deploy/.ssh
   apt update && apt -y upgrade
   ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
   Vultr's Ubuntu images ship with ufw enabled and only SSH open, so ports 80 and 443 must be opened.

4. **Node 22:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs
   node -v   # v22.x (better-sqlite3 13 needs >=22)
   ```

5. **Code.** Do this after the merge is finished and builds locally.
   - The simplest route is **rsync from your laptop**. It needs no push, and `landing/` is untracked anyway.
     ```bash
     # on the laptop, from /Users/pnagothu/hackgt13/inkling
     rsync -az --delete \
       --exclude node_modules --exclude .next --exclude data --exclude landing \
       --exclude '.env*' --exclude test-results --exclude screenshots --exclude notability-screenshots \
       ./ deploy@<IP>:/srv/inkling/
     ```
     Excluding `landing/` also matters because the root `tsconfig.json` includes `**/*.ts`. A leftover `landing/` without its `node_modules` can break `next build`'s typecheck.
   - Alternatively, commit and push, then `git clone` (use a deploy key if the repo is private).
   - Create `/srv/inkling` owned by `deploy` first: `sudo mkdir -p /srv/inkling && sudo chown deploy: /srv/inkling`.

6. **Environment.** As `deploy`, in `/srv/inkling`:
   ```bash
   umask 077 && nano .env.production.local
   ```
   ```dotenv
   DEMO_MODE=1
   INKLING_DISABLE_AI=1
   GROQ_API_KEY=<paste>            # /api/ask only
   LANDING_AI_DAILY_CAP=200
   NEXT_PUBLIC_SITE_URL=https://<your>.tech
   # no DATABASE_URL → SQLite at data/inkling.db
   # no OPENAI/GEMINI/XAI/ELEVENLABS keys
   ```
   **Never copy your laptop's `.env.local`.** It contains the dev `DATABASE_URL`, and the VPS would then write into your Tiger dev service.

7. **Install, build, seed:**
   ```bash
   cd /srv/inkling
   npm ci                      # dev deps are needed: tsx (seed), tailwind/typescript (build)
   npm run build               # NEXT_PUBLIC_SITE_URL must be present now (build-time inline)
   npm run seed:demo -- --reset
   ```

8. **Process manager. Option 8a: systemd** (no global installs). Create `/etc/systemd/system/inkling.service`:
   ```ini
   [Unit]
   Description=Inkling (Next.js)
   After=network.target

   [Service]
   User=deploy
   WorkingDirectory=/srv/inkling
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now inkling
   journalctl -u inkling -f
   ```

   **Option 8b: pm2.** Install it on the server only:
   ```bash
   sudo npm i -g pm2
   pm2 start node_modules/next/dist/bin/next --name inkling -- start -H 127.0.0.1 -p 3000
   pm2 save && pm2 startup   # run the printed sudo command
   ```

9. **Caddy.** Install with the official apt repo (see caddyserver.com/docs/install#debian-ubuntu-raspbian), then write `/etc/caddy/Caddyfile`:
   ```caddyfile
   www.<your>.tech {
     redir https://<your>.tech{uri} permanent
   }

   <your>.tech {
     encode zstd gzip
     # 5 MB covers the 4 MB strokes batch. Raise it to 310MB only if you keep lecture uploads on.
     request_body {
       max_size 5MB
     }
     header {
       Strict-Transport-Security "max-age=31536000"
       X-Content-Type-Options "nosniff"
       Referrer-Policy "strict-origin-when-cross-origin"
       X-Frame-Options "DENY"
       Permissions-Policy "camera=(), microphone=(), geolocation=()"
       -Server
     }
     reverse_proxy 127.0.0.1:3000
   }
   ```
   ```bash
   sudo systemctl reload caddy
   ```
   Caddy gets Let's Encrypt certificates automatically once DNS resolves to the VPS. It keeps the `Host` header, so `sameOriginOnly` works (section 5). It sets `X-Forwarded-For` from the real peer, so the `/api/ask` per-IP limits work. Its `encode` directive skips audio and video content types, so Range responses are unaffected.

10. **Smoke test:**
    ```bash
    curl -sI https://<your>.tech/welcome
    curl -s https://<your>.tech/api/health
    ```
    - `/api/health` should return `{"ok":true,"backend":"sqlite",...}`.
    - Open `/about` and check that it says `DEMO_MODE`.
    - Draw a quick session on an iPad and open a moment's help. It should show a hand-written card.
    - Scrub the lecture audio to confirm Range requests work.
    - Open Maya's compare page and check the PDF pane.
    - Ask the landing assistant one question.

11. **Scheduled reset.** Run `crontab -e` as `deploy`:
    ```cron
    # every 30 min: rebuild Maya + classmates (visitor sessions stay)
    */30 * * * * cd /srv/inkling && npm run seed:demo -- --reset >> /home/deploy/seed.log 2>&1
    # 04:00 daily: wipe visitor sessions too
    0 4 * * * sudo systemctl stop inkling && cd /srv/inkling && rm -f data/inkling.db data/inkling.db-wal data/inkling.db-shm && rm -rf data/uploads && npm run seed:demo && sudo systemctl start inkling >> /home/deploy/seed.log 2>&1
    ```
    The second line needs passwordless sudo for `systemctl stop/start inkling`, via a sudoers drop-in. SQLite's WAL mode lets the seed run while the app is up.

12. **Redeploy loop:**
    ```bash
    rsync ...                   # the same command as step 5
    ssh deploy@<IP> 'cd /srv/inkling && npm ci && npm run build && sudo systemctl restart inkling'
    ```

**Variant B′.** For the Tiger Data prize on the public site, point the VPS at a separate prod Tiger service by adding `DATABASE_URL` to `.env.production.local`. Everything else stays the same. SQLite has fewer moving parts, and your laptop already demonstrates Tiger live.

**Option B effort:** about 60–90 minutes, most of it waiting on DNS, `npm ci` and the build.

---

## 3. Domain setup (.tech from MLH)

1. **Claim the domain** through the MLH/.TECH offer for your event, using the code from the MLH hackathon page. Registrations are usually free for the first year; renewal is paid.
   - Verify the registrant email right away. Unverified new domains can be suspended.
   - In the registrar's DNS panel (the get.tech control panel), **delete any default parking A or CNAME records** before adding yours.
2. **Set TTLs to 300 seconds** while you're iterating.

### DNS for Option A (Vercel)

Add both `<your>.tech` and `www.<your>.tech` under Project → Settings → Domains, then create these records at the registrar:

| Type | Host | Value |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com.` |

If the dashboard shows a project-specific target, use that instead. Vercel issues the certificate automatically. Make the apex the primary domain and redirect `www` to it. You could instead delegate nameservers to `ns1.vercel-dns.com` and `ns2.vercel-dns.com`, but plain records are faster to reason about.

### DNS for Option B (Vultr)

| Type | Host | Value |
|---|---|---|
| A | `@` | `<VPS IPv4>` |
| AAAA | `@` | `<VPS IPv6>` (only if IPv6 is enabled on the instance) |
| CNAME | `www` | `<your>.tech.` (or an A record to the same IPv4) |

Check with `dig +short <your>.tech` before starting Caddy. Caddy retries anyway, but repeated failures can hit Let's Encrypt rate limits.

**Cloudflare:** if you move the nameservers to Cloudflare, keep the records **DNS-only (grey cloud)**. The orange-cloud proxy would make every client IP a Cloudflare IP for the `/api/ask` limits, unless you configure `trusted_proxies`.

### Routing `/welcome` and `/app` (for the merge)

- **Don't use `basePath: "/app"`.** It doesn't prefix `fetch("/api/...")` literals (there are 11 or more in `components/`), and it would also move `/welcome`.
- Keep `/api/*` and the deep app routes (`/session/[id]`, `/review/[id]`, and so on) at the root. Put the app home at `app/app/page.tsx` and the landing page at `app/welcome/page.tsx`.
- Redirect `/` → `/welcome` with **`next.config.ts` `redirects()`**, not a `proxy.ts`.
- If a `proxy.ts` is unavoidable, its `matcher` must exclude `/api`. With a proxy present, Next buffers bodies to 10 MB (`experimental.proxyClientMaxBodySize`) and silently truncates anything larger. The comment at `app/api/lectures/route.ts:35-37` assumes no proxy.
- `landing/components/site.ts:7` already defaults `APP_URL` to `"/app"`. Update any in-app `href="/"` "home" links to `/app`.
- Drop `borrowParentEnv` (`landing/next.config.ts:12-30`) during the merge. The main app reads `.env*` natively.

---

## 4. Recommendation

**Go with Option B (Vultr + SQLite + DEMO_MODE + Caddy)** tonight:

1. **It is the path that's already tested.**
   - `npm run demo` does `next start`, SQLite and `DEMO_MODE=1`.
   - `e2e/demo.spec.ts` runs against exactly that.
   - Nothing about storage, media Range, the seeded PDF or native modules changes.
2. **Mandatory work is env-only:**
   - `DEMO_MODE=1`
   - `INKLING_DISABLE_AI=1`
   - no dev `DATABASE_URL`
   - a Caddy body cap of 5 MB, which also shuts off lecture and PDF uploads without code (they fail with 413)
3. **It adds the Vultr prize,** with automatic HTTPS and an exact single-process rate limiter.
4. **Option A needs code in files the other agent is touching right now** (`next.config.ts`, the upload UI), plus a second Tiger service, a commit and push of an in-flux tree, and it still has per-instance limits.

**Order of work:**

1. Finish the merge and check that `npm run build && npm run demo` passes locally.
2. Claim the domain and create the VPS in parallel. Add DNS records.
3. Run steps 3–10 of the runbook.
4. If time allows, make the small code hardening changes: the upload guard in DEMO_MODE (A-change 2) and the transcription guard (A-change 4). Redeploy.
5. Add the cron reset.

Keep the laptop for live AI: `npm run dev` with your normal `.env.local`, which has DEMO_MODE empty, live keys and the dev Tiger service.

---

## 5. Pre-deploy checklist

### Cost and abuse

- [ ] `DEMO_MODE=1` **and** `INKLING_DISABLE_AI=1` on the public host. Then check both of these:
  - `/about` shows "Demo fixtures (DEMO_MODE, offline)".
  - `POST /api/lectures/<id>/transcribe` returns 503 "AI not configured".
- [ ] Only `GROQ_API_KEY` is present on the public host, for `/api/ask`. No OpenAI, Gemini, xAI or ElevenLabs keys.
- [ ] Set `LANDING_AI_DAILY_CAP` (e.g. 200). Set `LANDING_AI_DISABLED=1` if you want the assistant fully offline.
- [ ] **Uploads are off publicly.** Use the Caddy `request_body max_size 5MB`, or the DEMO_MODE guard in `app/api/lectures/route.ts:39` and `app/api/sessions/[id]/notability/route.ts:34`. Without this:
  - strangers can upload up to 300 MB each, filling the disk
  - their uploads are listed to everyone through `GET /api/lectures`
  - the lecture list's content can't be moderated
- [ ] **Demo reset is scheduled** (cron in runbook step 11). All visitors share `LOCAL_STUDENT_ID`, and `POST /api/sessions/[id]/strokes` accepts writes to `demo-maya-*` sessions, which also shifts `/insights/evaluation`.
- [ ] **Rate limits.**
  - AI: per session, in memory (`lib/ai/service.ts:100,139-148`). Sessions are free to create, so this isn't a real per-user limit. It doesn't matter in DEMO_MODE, since there is no spend.
  - `/api/ask`: per IP, in memory. Exact on the VPS, approximate on Vercel.
  - No limit on session creation or strokes. Acceptable for a demo. Caddy's stock build has no rate limiter; `caddy-ratelimit` is a plugin and isn't worth it tonight.

### Security headers

- [ ] **The main app sends none today**: `next.config.ts` has no `headers()`. Only `landing/next.config.ts:33-38` does. Either:
  - add them at Caddy (runbook step 9), or
  - carry the landing's `securityHeaders` and `poweredByHeader: false` into the merged `next.config.ts`, and add HSTS. Vercel adds HSTS on its own domains; on the VPS, Caddy adds it.
- [ ] `X-Frame-Options: DENY` and `Permissions-Policy: microphone=()` are safe. The app never calls `getUserMedia`, and read-aloud uses `speechSynthesis`, which is not gated.
- [ ] Skip a CSP tonight, or use `Content-Security-Policy-Report-Only`. The pdf.js worker and Next's inline scripts need care.

### `sameOriginOnly` behind a proxy or custom domain (`lib/http.ts:8-16`)

- [ ] It compares `new URL(Origin).host` to the raw `Host` header. A missing `Origin` is allowed (curl, beacons without Origin).
  - **Vercel:** `Host` is the custom domain, so it works.
  - **Caddy:** `reverse_proxy` keeps the client's `Host`, so it works. **Don't** add `header_up Host {upstream_hostport}`.
  - **nginx** (if you ever swap): it needs `proxy_set_header Host $host;`, or every POST gets 403.
- [ ] `www` → apex redirects happen on GET before any POST, so there is no mismatch.
- [ ] Access over `http://IP:3000` would also be consistent, but binding to 127.0.0.1 (runbook step 8) removes it anyway.
- [ ] Optional robustness: also accept `x-forwarded-host`, as `landing/lib/ask/origin.ts:6-9` does. That is safe here, because a cross-site page can't set custom headers without a CORS preflight, which the app never approves.
- [ ] `GET` routes wrapped in `sameOriginOnly` (export, health, ink-stats, hotspots, and others) are fine. Browsers send no Origin on same-origin navigations or downloads.

### No keys shipped to the client

- [ ] `NEXT_PUBLIC_` is used in only two places, and neither holds a secret:
  - `NEXT_PUBLIC_SITE_URL` (`landing/app/layout.tsx:21`)
  - `NEXT_PUBLIC_APP_URL` (`landing/components/site.ts:7`)
- [ ] No `"use client"` file reads `process.env`, and there is no `env:` block in either `next.config`.
- [ ] Provider keys are read server-side only (`lib/ai/select.ts`, `lib/ai/tts.ts`, `lib/transcribe.ts`, `landing/app/api/ask/route.ts:98`).
- [ ] A regex scan of the tree (excluding `node_modules` and `.env.local`) found no hard-coded keys or DB URLs. The Postgres URLs in `lib/dbPostgres.ts:143` and `lib/__tests__/dbPostgres.test.ts` are placeholders.
- [ ] After the build, run `grep -rE "gsk_|sk-|xai-|tsdb.cloud" .next/static` locally. It should return nothing.

### Environment files are git-ignored

- [ ] `.gitignore:34` has `.env*` with `!.env.local.example`, and `landing/.gitignore:21` has `.env*`. `git check-ignore` confirms `.env.local` and `landing/.env.local` are ignored.
- [ ] `git log --all` shows only `.env.local.example` ever committed; the real `.env.local` never was.
- [ ] `/data` (the SQLite DB and uploads) is ignored.
- [ ] On the VPS, `.env.production.local` is `chmod 600` and owned by `deploy`. Never rsync or copy the laptop's `.env.local`.

### Build and merge sanity

- [ ] The root `tsconfig.json` includes `**/*.ts`. After the merge, delete `landing/` or add `"landing"` to `exclude`, so its sources aren't typechecked without its `node_modules`.
- [ ] The merged deps are in the root `package.json`. The diff shows `framer-motion`, `motion`, `clsx`, `tailwind-merge` and `@paper-design/shaders-react` added, and `pdf-lib` moved to `dependencies`.
- [ ] The 12.8 MB `inkling-demo.mp4` moves into `public/`. It is served statically: Vercel's CDN supports Range, and so does Next's `public` serving on the VPS. Keep the poster image and the `.vtt` alongside it.
- [ ] Set `NEXT_PUBLIC_SITE_URL` *before* `next build`.
- [ ] Run `npm run build && npm run demo` locally, then `npx playwright test e2e/demo.spec.ts`, before shipping.
- [ ] On the live host, check `/api/health` shows the expected backend, `/about` shows DEMO_MODE, the audio scrubs, the compare page shows the PDF, and `/welcome` → `/app` navigation works.
