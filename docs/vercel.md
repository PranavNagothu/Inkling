# Deploying the public demo on Vercel (backup to Railway)

The main deploy is Railway ([`docs/railway.md`](railway.md)). This is a **parallel backup**: the same
app, in `DEMO_MODE`, on a free `*.vercel.app` URL. It lives on the **`vercel` branch**. Railway
(`main`) is not touched.

## How it works (one paragraph)

Vercel has no persistent disk. Each function instance keeps its own **throwaway SQLite database in
`/tmp/inkling`** (`lib/paths.ts`: the default data folder when `VERCEL=1`). `instrumentation.ts`
seeds the demo into it at cold start, before the first request is served. It is the same seed as
`npm run seed:demo`, including Maya's Notability PDF (`lib/vercelDemo.ts`). The seed takes about
0.3–1.1 s, and a whole cold start about 0.6 s locally. The periodic demo reset is off on Vercel:
every new instance starts fresh anyway.

`vercel.json` pins the `@vercel/static-build` builder. It runs `npm run vercel-build`
(`scripts/vercel-build.mjs`), which builds Next's standalone server and writes `.vercel/output`
(Build Output API) with **one** function, `index`, that serves every page and API route.
`public/` and `/_next/static` go to the CDN. With Vercel's stock Next.js builder, pages and API
routes would run in different functions with different `/tmp`s, so a session created by the API
would 404 on its page.

## Steps

1. Go to **vercel.com** and sign in with GitHub.
2. Click **Add New… → Project**.
3. Under **Import Git Repository**, find **`PranavNagothu/Inkling`** and click **Import**.
   - If it isn't listed, click **Adjust GitHub App Permissions** and grant access to the repo.
4. On the **Configure Project** screen:
   - **Project Name:** e.g. `inkling-demo`. This becomes `inkling-demo.vercel.app`.
   - **Framework Preset:** leave whatever it detects. `vercel.json` has a `builds` entry that
     overrides the build settings, so ignore the Build/Output settings. Vercel will warn that
     *"Build and Development Settings … will not apply"*. That is expected.
   - **Root Directory:** `./`
   - **Environment Variables:** add these now (see the table below):
     - `DEMO_MODE` = `1`
     - `LANDING_AI_DAILY_CAP` = `200`
     - optionally `GROQ_API_KEY`
5. **Deploy the `vercel` branch.** The import screen deploys the default branch (`main`), which has
   no Vercel setup. Do one of the following:
   - **Easiest (production URL):** let the first deploy run (or cancel it). Then go to **Project →
     Settings → Git → Production Branch**, set it to **`vercel`**, and click **Save**. Then go to
     **Deployments**, open the **⋯** menu on the latest `vercel` deployment, and click
     **Redeploy**. If there is none, push any commit to `vercel`, or use the next option.
   - **Or (preview URL):** go to **Deployments → Create Deployment** (top right), enter branch
     **`vercel`**, and click **Create**. You get a preview URL. It is public unless Deployment
     Protection is on: check **Settings → Deployment Protection → Vercel Authentication** and set
     it to off, or to "Only Production Deployments".
6. Wait for **Ready**. The build takes about 1–2 minutes.
7. **Get the URL.** Go to **Project → Overview → Domains**, e.g. `https://inkling-demo.vercel.app`,
   or click **Visit**.
8. **Smoke test.** Open each of these:
   - `/api/health` should return `{"ok":true,"backend":"sqlite",...}`.
   - `/welcome`
   - `/app`
   - `/review/demo-maya-1`: the audio should play and scrub.
   - `/compare/demo-maya-1`: the Notability PDF pane should render.
   - `/progress`
   - `/insights/demo-maya-1`
   - `/teacher/demo-chain-rule`
9. Optional: set **`NEXT_PUBLIC_SITE_URL`** to the final URL and **Redeploy**. Without it, the
   landing page's og:image uses `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel sets automatically.

### Environment variables (Project → Settings → Environment Variables, Production + Preview)

| Name | Value | Required | Why |
|---|---|---|---|
| `DEMO_MODE` | `1` | **yes** | Public demo: uploads, transcription and live mode are off, and AI comes from bundled fixtures. **It also turns on the cold-start seed.** It must be set at build time too, because `/welcome` is prerendered. |
| `LANDING_AI_DAILY_CAP` | `200` | recommended | Global daily cap on Groq calls from the landing page's "Ask Inkling". It is **per instance** on Vercel. |
| `GROQ_API_KEY` | your key | optional | Live answers in "Ask Inkling" (`/api/ask`). Without it, the offline FAQ answers. It is never sent to the browser. |
| `NEXT_PUBLIC_SITE_URL` | `https://<project>.vercel.app` | optional | Absolute URLs for og:image. It is read at build time, so redeploy after changing it. |

**Do not set** `DATABASE_URL` (that switches to Postgres and disables the seed), `INKLING_DATA_DIR`
(the default `/tmp/inkling` is correct), or `DEMO_RESET_MINUTES` (it is ignored on Vercel).
Also set **Settings → Functions → Function Region** to **Washington, D.C. (iad1)**, if it isn't
already. `vercel.json` requests it too.

## Custom domain

`www.inklingapp.tech` currently points to **Railway** via a CNAME to `belklbgg.up.railway.app`, set
at **get.tech**. Leave it there unless Railway fails. To move it to Vercel:

1. In Vercel, go to **Project → Settings → Domains → Add**, enter `www.inklingapp.tech`, and click
   **Add**. Vercel shows the CNAME target, usually `cname.vercel-dns.com.` or a project-specific
   `…vercel-dns-XXX.com`.
2. At **get.tech**, go to DNS management for `inklingapp.tech`. Edit the `www` **CNAME** from
   `belklbgg.up.railway.app` to the Vercel target.
3. Wait for Vercel to show **Valid Configuration**, which usually takes minutes. The TLS
   certificate is issued automatically.
4. **To switch back,** point the CNAME at `belklbgg.up.railway.app` again. Railway still has the
   domain attached.

Changing the CNAME sends visitors away from Railway. Railway keeps running, but only on its
`*.up.railway.app` URL until you switch back.

## Limitations (per-instance data)

- **Every instance has its own copy of the demo.** At demo traffic, Vercel usually serves everyone
  from one warm instance, since Fluid compute sends concurrent requests to the same instance. Under
  load or after a cold start, a visitor may be routed to a different instance. **A session they
  created, or ink they drew, can then vanish, or their new session can 404.** Maya's seeded
  sessions are always there, because every instance seeds them. Their IDs are deterministic.
- **Instances recycle after idle time,** and then everything drawn is gone. That doubles as a free
  demo reset.
- The **first request after idle** pays the cold start: about 0.6 s locally, more on Vercel,
  including about 0.3–1.1 s of seeding.
- The `/api/ask` per-IP limits and `LANDING_AI_DAILY_CAP` are **per instance** and approximate.
- Uploads, the Notability PDF import, transcription and live mode are disabled (`DEMO_MODE`).
  Vercel also caps request bodies at 4.5 MB.
- The build uses whatever **Node.js Version** the project is set to, and the function runs on the
  same major. 22.x or 24.x both work, because the better-sqlite3 addon is N-API and the Linux
  prebuilds are bundled.

## Check it locally (no login, no deploy)

```bash
# In a checkout of the vercel branch
echo '{"projectId":"_","orgId":"_","settings":{}}' > .vercel/project.json   # mkdir -p .vercel first
DEMO_MODE=1 npx vercel build --yes          # runs npm run vercel-build; writes .vercel/output
ls .vercel/output/functions                  # → index.func (one function)
```

`npx vercel build` needs no Vercel account. To run the built function, serve
`.vercel/output/static` for existing files. Pass everything else to
`require(".vercel/output/functions/index.func/___inkling_launcher.cjs")` as a Node `(req, res)`
handler, with `VERCEL=1 DEMO_MODE=1`. This is how the `demo` and `landing` Playwright projects
were run against it (`E2E_DEMO_PORT=<port>` reuses a server already listening there).
