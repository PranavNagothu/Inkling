# Deploying Inkling on Railway (public demo at inklingapp.tech)

This deploys one Railway service that builds the repo's `Dockerfile` and runs `scripts/start-prod.mjs`. It stores SQLite, the seeded Notability PDF and any other files on a Railway Volume mounted at `/data`, and serves the offline demo (`DEMO_MODE=1`).

**No database service is involved.** Do not add Postgres or Tiger Data, and do not set `DATABASE_URL`.

Everything below is click-by-click. You need about 20 minutes, plus DNS and certificate waits.

---

## What the repo already does

| Piece | Where | What it does |
|---|---|---|
| Build | `Dockerfile` (selected by `railway.json`) | Uses Node 22 on Debian bookworm. `npm ci` builds better-sqlite3 (a native module) with the bundled linux prebuild; then `next build` runs. |
| Start | `scripts/start-prod.mjs` (`npm run start:railway`) | 1. Creates `/data`, `/data/uploads/notability` and `/data/tts`. 2. Seeds the demo if it is missing, or rebuilds it when `DEMO_RESET_ON_START=1`. 3. Runs `next start -H 0.0.0.0 -p $PORT`. |
| Periodic reset | `instrumentation.ts` → `lib/demoReset.ts` | See the note below this table. |
| Health check | `/api/health`, configured in `railway.json` | Returns `{"ok":true,"backend":"sqlite"}`, or 503 if the database can't be opened. |
| Restart policy | `railway.json` | On failure, up to 10 retries. |
| Public lock-down | `DEMO_MODE=1` | See the note below this table. |

**Periodic reset.** Every `DEMO_RESET_MINUTES` (default 30):

- Maya's sessions are rebuilt.
- Visitor sessions older than `DEMO_KEEP_VISITOR_MINUTES` (default 60) are deleted.
- Everything runs inside one SQLite transaction. Requests that arrive during the reset (about 0.2 s) wait for it to finish rather than failing.

**Public lock-down with `DEMO_MODE=1`:**

- These routes answer 403 and show a disabled control with the note "…available when you run Inkling yourself":
  - lecture upload
  - Notability PDF import and replace
  - Whisper auto-transcribe
  - Live lecture
- All re-teach AI comes from the bundled fixtures (offline).
- The only route that can call a model is the landing assistant, `/api/ask`, and only if `GROQ_API_KEY` is set. It keeps its per-IP limits and its daily cap.

---

## 1. Create the project from GitHub

1. Go to <https://railway.com> and log in with GitHub.
2. Click **New Project** → **Deploy from GitHub repo**.
   - If Railway asks, click **Configure GitHub App** and grant it access to **PranavNagothu/Inkling**.
3. Pick **PranavNagothu/Inkling**. Railway creates a service and starts building from `main`. It finds `railway.json`, so it uses the Dockerfile.
   - The first build may start before the variables are set. That's fine; you'll redeploy in step 4.

## 2. Add the Volume at `/data`

1. On the project canvas, right-click the **Inkling** service → **Attach Volume**. (Or press ⌘K / Ctrl+K and type "Volume".)
2. Set the **Mount path** to `/data`, then click **Add** or **Attach**.

**Why this matters:**

- Without a volume, the database lives inside the container and is wiped on every deploy. The app still works, because it re-seeds on start, but visitor sessions vanish.
- A service with a volume runs one replica, and each redeploy has a few seconds of downtime. That's fine for a demo.
- The container runs as root, so it can write to the volume. Nothing to configure.

## 3. Set the variables

Open the service → **Variables** → **Raw Editor**. Paste the block below and set the values. Never paste keys anywhere else.

```dotenv
DEMO_MODE=1
INKLING_DATA_DIR=/data
NODE_ENV=production
PORT=3000
NEXT_PUBLIC_SITE_URL=https://www.inklingapp.tech
DEMO_RESET_ON_START=1
DEMO_RESET_MINUTES=30
DEMO_KEEP_VISITOR_MINUTES=60
# Optional: live answers in the landing assistant (/api/ask) only. Leave unset for offline answers.
GROQ_API_KEY=<your Groq key>
LANDING_AI_DAILY_CAP=200
```

| Variable | Value | Notes |
|---|---|---|
| `DEMO_MODE` | `1` | Required. Offline fixtures; uploads, Whisper and Live lecture are off (403). |
| `INKLING_DATA_DIR` | `/data` | Required. Must match the volume's mount path. The DB is `/data/inkling.db`, uploads and PDFs go in `/data/uploads`, and the TTS cache in `/data/tts`. The Dockerfile defaults to `/data` too. |
| `NODE_ENV` | `production` | The start script sets it anyway. |
| `PORT` | `3000` | Pins the port, so the domain's target port is always 3000. |
| `NEXT_PUBLIC_SITE_URL` | `https://www.inklingapp.tech` | The base for `og:image` and similar links. **It is baked in at build time.** Change it, then **redeploy**. Use `https://inklingapp.tech` only if the apex is served directly (see 6b, option 2). |
| `DEMO_RESET_ON_START` | `1` | Rebuilds Maya's sessions on every deploy or restart. Without it, the demo is seeded only when missing. |
| `DEMO_RESET_MINUTES` | `30` | Interval of the in-process reset. `0` turns it off. |
| `DEMO_KEEP_VISITOR_MINUTES` | `60` | Visitor sessions younger than this survive a reset. `0` removes them all at every reset. |
| `GROQ_API_KEY` | optional | Used **only** by `/api/ask`. DEMO_MODE blocks Whisper, so this key can't be spent on transcription. |
| `LANDING_AI_DAILY_CAP` | e.g. `200` | Global daily cap on assistant model calls (default 500). `LANDING_AI_DISABLED=1` keeps the assistant fully offline. |

**Do not set these:**

- `DATABASE_URL`: it would switch storage to Postgres and ignore the volume.
- `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `ELEVENLABS_API_KEY`: DEMO_MODE doesn't use them. Leaving them out removes any chance of spend.

`INKLING_DISABLE_AI=1` is optional and changes nothing here, because DEMO_MODE already wins. Note that it does **not** turn off `/api/ask`; only `LANDING_AI_DISABLED=1` or an unset `GROQ_API_KEY` does.

## 4. Deploy

1. Click **Deploy** on the staged changes banner, or **Deployments** → ⋯ → **Redeploy**.
2. Watch the build logs. `npm ci` then `next build` take about 3–6 minutes.
3. Watch the deploy logs. You should see:

   ```text
   ▸ Inkling (production) · storage: SQLite at /data/inkling.db · files under /data
   ▸ DEMO_MODE: seeding the demo (DEMO_RESET_ON_START=1: rebuilding it)
   Seeded the demo into SQLite (/data/inkling.db).
   ▸ The demo resets every 30 min …
   ▸ next start on 0.0.0.0:3000
   [inkling] DEMO_MODE: the demo resets every 30 min
   ```

4. The deploy turns green once `/api/health` answers 200.

## 5. Generate the Railway domain

1. Open the service → **Settings** → **Networking** → **Public Networking** → **Generate Domain**.
2. If Railway asks for the target port, enter **3000**.
3. You get something like `inkling-production.up.railway.app`. Open it: `/` redirects to `/welcome`.

## 6. Custom domain: inklingapp.tech (registered at get.tech)

### 6a. www.inklingapp.tech → Railway (do this first)

1. In Railway, open the service → **Settings** → **Networking** → **+ Custom Domain**.
   - Enter `www.inklingapp.tech`.
   - Target port **3000**.
2. Railway shows **two records**. Copy both exactly:
   - a **CNAME**: `www` → something like `abc123.up.railway.app`
   - a **TXT**: `_railway-verify.www` (or similar) → a `railway-verify=…` value

   **Both are required.** With only the CNAME, the domain returns 404 until the TXT verifies.
3. In get.tech, log in at <https://manage.get.tech> (the .TECH control panel), then:
   1. Go to **Domains** → **List / Search Orders** → click `inklingapp.tech`.
   2. Click **Manage DNS**, which opens the DNS panel.
   3. Delete any default parking records for `www` (a CNAME or A record).
   4. Open the **CNAME Records** tab → **Add CNAME Record**.
      - **Host name:** `www` (only the part before `.inklingapp.tech`; the panel appends the domain).
      - **Value / Points to:** the Railway target, e.g. `abc123.up.railway.app`.
      - **TTL:** `300`, or the lowest the panel allows.
   5. Open the **TXT Records** tab → **Add TXT Record**.
      - **Host name:** the TXT name Railway shows, without `.inklingapp.tech` (e.g. `_railway-verify.www`).
      - **Value:** the exact value Railway shows.
      - **TTL:** `300`.
4. Check from a terminal:

   ```bash
   dig +short CNAME www.inklingapp.tech          # → abc123.up.railway.app.
   dig +short TXT _railway-verify.www.inklingapp.tech
   ```

5. Wait for Railway to show a green check next to the domain. Certificate issuance (Let's Encrypt) usually takes minutes and at most about an hour after DNS resolves. Then <https://www.inklingapp.tech> works.

### 6b. The apex inklingapp.tech

A CNAME can't sit at the apex. Railway supports the apex only through **CNAME flattening** or an **ALIAS/ANAME** record at your DNS provider; it names Cloudflare, DNSimple, Namecheap and bunny.net.

The get.tech DNS panel, a LogicBoxes/Radix panel, offers A, AAAA, CNAME, MX, NS, TXT and SRV records, and **no ALIAS/ANAME or flattening**. I couldn't open their help pages to confirm this. If your panel does show an ALIAS or ANAME type, use it like the CNAME in 6a.

**Option 1: forward the apex to www (fastest, recommended tonight).**

1. In the get.tech control panel, on the domain's page, open **Domain Forwarding**.
2. Forward `inklingapp.tech` → `https://www.inklingapp.tech`.
   - Choose a permanent (301) redirect if offered, and turn on path forwarding if offered.
   - Leave masking/frame forwarding **off**. The app sends `X-Frame-Options: DENY`, so a masked frame would stay blank.
3. Keep `NEXT_PUBLIC_SITE_URL=https://www.inklingapp.tech`.
4. You **don't** add the apex in Railway for this option. Railway only serves `www`.

**Caveat:** registrar forwarding is often **HTTP-only**. `http://inklingapp.tech` redirects fine, but `https://inklingapp.tech` may show a certificate warning, because the forwarder has no certificate for your apex. Test both. If HTTPS on the apex matters (for example, because the Devpost link is `https://inklingapp.tech`), use option 2, or make the Devpost link `https://www.inklingapp.tech`.

**Option 2: Cloudflare DNS (free), which serves the apex with HTTPS.**

1. Create a free Cloudflare account → **Add a site** → `inklingapp.tech` → Free plan.
2. Cloudflare imports the existing records. Then add these, each **DNS only (grey cloud)**:
   - `CNAME www → abc123.up.railway.app`
   - `CNAME @ → <the apex target Railway shows>` (Cloudflare flattens it)
   - both `_railway-verify…` TXT records
3. In get.tech: domain page → **Name Servers** → replace them with the two Cloudflare nameservers. `.tech` NS changes usually apply within an hour.
4. In Railway, add **both** `inklingapp.tech` and `www.inklingapp.tech` as custom domains. Each gets its own CNAME target and TXT record.
5. Set `NEXT_PUBLIC_SITE_URL=https://inklingapp.tech` and **redeploy**.

Keep the Cloudflare proxy **off** (grey cloud):

- With the orange cloud, every client IP becomes a Cloudflare IP to the assistant's per-IP limits.
- Railway also has to issue its certificate through the proxy.

**Same-origin check:** the app refuses cross-site POSTs by comparing `Origin` with `Host` or `X-Forwarded-Host` (`lib/http.ts`). The apex and www are different origins. That's fine, because visitors always end up on one host (the forward or redirect happens on GET), and all the app's POSTs go to the host the page came from.

## 7. Smoke test (about 3 minutes)

```bash
SITE=https://www.inklingapp.tech
curl -s $SITE/api/health                                  # {"ok":true,"backend":"sqlite","timescale":false}
curl -sI $SITE/ | grep -i location                        # /welcome
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-1023' $SITE/api/lectures/demo-chain-rule/media   # 206
curl -s -X POST -H "Origin: $SITE" $SITE/api/lectures/demo-chain-rule/transcribe   # 403 "Auto-transcribe is available when you run Inkling yourself."
```

Then check in a browser (an iPad too):

- `/welcome` → the app link → `/app` shows Maya's two sessions.
- `/review/demo-maya-1`: **Replay** plays audio, and opening a moment shows a hand-written help card.
- `/compare/demo-maya-1`: the Notability PDF renders; **Replace PDF** is disabled.
- `/progress` and the teacher view `/teacher/demo-chain-rule`.
- `/lectures/new`: the upload form is disabled, with the note.
- `/about` shows "Demo fixtures (DEMO_MODE, offline)".
- Ask the landing assistant one question.

## 8. Operating it

- **Reset now:** Deployments → ⋯ → **Restart**. With `DEMO_RESET_ON_START=1`, the demo is rebuilt on start.
- **Wipe everything,** including visitor sessions:
  1. Remove and re-attach the volume, or set `DEMO_KEEP_VISITOR_MINUTES=0`.
  2. Restart. The next periodic reset then removes all visitor sessions.
- **Logs:** each reset prints `[inkling] demo reset in N ms (K visitor sessions removed)`.
- **Changed `NEXT_PUBLIC_SITE_URL`?** Redeploy; a restart isn't enough, because the value is baked in at build time.

### Why the reset runs in-process, not as a Railway cron job

Railway cron services are separate services, and **a volume attaches to one service only**. A cron job therefore can't open `/data/inkling.db`. It could only call an HTTP "reset" endpoint, which would be one more thing on the public internet to protect.

The in-process timer shares the app's database handle. It:

- takes the same (student, lecture) lock the app's writers use, then one SQLite transaction
- makes requests during the ~0.2 s reset wait rather than fail
- guarantees a visitor never sees a half-rebuilt demo
- deletes the replaced PDF files only after COMMIT

**If you ever prefer no timer:** set `DEMO_RESET_MINUTES=0`, keep `DEMO_RESET_ON_START=1`, and restart the deployment when you want a fresh demo. The tradeoff is manual resets, and drawings stay until the next restart.

### Local rehearsal of the production setup

```bash
INKLING_DIST_DIR=.next-rail NEXT_PUBLIC_SITE_URL=https://www.inklingapp.tech DATABASE_URL= npx next build
DEMO_MODE=1 INKLING_DATA_DIR=/tmp/inkling-data DATABASE_URL= INKLING_DIST_DIR=.next-rail PORT=3500 \
  DEMO_RESET_MINUTES=0.5 npm run start:railway
```

`npm run demo` (the laptop demo) never sets `DEMO_RESET_MINUTES`, so a rehearsal is never reset under you.
