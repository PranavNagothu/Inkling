# Inkling

**Every other app deletes your mistakes. We keep them.**

Inkling is a note-taking canvas for lectures (built for the iPad + Pencil) that keeps what you erase.
Erased handwriting stays as _ghost ink_; Inkling notices where you hesitated (slower writing,
erasing, going quiet while the lecturer keeps talking), pairs each erase with its correction, and
links every moment to that point in the lecture. The review turns a session into a learning timeline —
**corrected misconceptions**, **unresolved gaps** and **breakthroughs** — with an AI re-explanation and
a check question for each, gaps that follow you into your next session, and a side-by-side with your
Notability export that shows what the final page hides.

Built solo at HackGT 13.

## Run it

```bash
npm install
cp .env.local.example .env.local   # optional: AI / voice keys, Postgres URL (everything works without)
npm run dev                          # http://localhost:3000 → /welcome
```

One site: `/welcome` is the marketing page (with the "Ask Inkling" assistant, `POST /api/ask`), `/app`
is the app's home, and `/` redirects to `/welcome`. The two have separate root layouts and stylesheets
(`app/(marketing)` and `app/(product)`); the other app routes (`/session/…`, `/review/…`, `/compare/…`,
`/progress`, …) and every API under `/api` are unchanged. `landing/` is the former standalone
marketing site, kept for reference only (not built, typechecked or linted).

Node 22+. Everything is stored in a local SQLite file (`data/inkling.db`) unless `DATABASE_URL` is set.

## The demo

```bash
npm run seed:demo            # add Maya's demo sessions (idempotent)
npm run seed:demo -- --reset # rebuild them after a rehearsal (touches nothing else)
npm run demo                 # seed + production build (only if stale) + next start, DEMO_MODE=1
```

`npm run demo` serves the production build on `0.0.0.0:3000` and prints the LAN address — open
`http://<your-laptop-ip>:3000` on the iPad (same Wi-Fi or a hotspot). Options:
`npm run demo -- --reset | --no-build | --build | --port 3001 | --host 127.0.0.1`.

**It runs with no network at all.** DEMO_MODE serves hand-checked AI fixtures
(`public/demo/ai-cache.json`) instead of calling a model, fonts are self-hosted by `next/font` at
build time, the pdf.js worker is bundled, and read-aloud falls back to the browser's voice. Build once
while online (`next build` downloads the fonts), then demo anywhere. `e2e/demo.spec.ts` walks the whole
demo against the production server with every non-localhost request blocked.

What the seed creates (on SQLite or Postgres — whatever the app is using):

- **Maya — Session 1** (yesterday, on the bundled chain-rule lecture): two columns of handwritten notes.
  At 01:02 she stopped after the outer derivative, erased `2(3x+1)` and rewrote `6(3x+1)` — already
  answered, a **breakthrough**. At 01:40 she wrote `d/dx sin(x²) = cos(x²)`, erased it and rewrote
  `cos(x²) · 2x` — the **live correction** for the demo. At 04:10 (product vs chain rule) she slowed down,
  erased her attempt and went quiet while the lecture moved on — a **gap**.
- **Maya — Session 2** (today): rewatches that part and writes the example through calmly, which
  resolves the gap by revisit.
- A **Notability export** of Session 1 (a one-page PDF of the final page, generated with pdf-lib).
- Five classmates' sessions (not listed on the home page) so "Where the class slowed down" has a shape.

The two-minute path: **Home → Session 1 review → the 01:40 correction** (before/after crops, the AI
reading "forgot the inner derivative", the re-explanation; answer the check question → **Breakthrough**)
**→ the 04:10 gap** (Replay 20 s) **→ Compare with Notability** (overlay slider) **→ Progress** (gap
resolved in Session 2, class hotspots) **→ About** (`/about`: backend, AI provider, voice, attribution).

### Using a real lecture

Add it with **Add lecture** (audio or video, plus `.vtt`/`.srt` captions, or Whisper with an OpenAI
or Groq key; files up to 25 MB). The lecture file stays in `data/uploads` (gitignored) — never
commit it. For MIT OCW 18.01
Lecture 4, the chain rule runs roughly 22:05–33:00; clip that part to keep the demo short. A lecture
whose title mentions MIT / 18.01 / OpenCourseWare is credited on `/about` as
_"Lecture: MIT OpenCourseWare 18.01 Single Variable Calculus, CC BY-NC-SA — ocw.mit.edu"_. The seeded
demo always uses the bundled synthetic lecture (`public/demo/`), which needs no attribution.

## Environment

All optional; see `.env.local.example` for details. Keys are read on the server only and never logged.

| Variable | What it does |
| --- | --- |
| `AI_PROVIDER` | `openai` \| `groq` \| `gemini` \| `grok` \| `fake`; unset = first key found (OpenAI → Groq → Gemini → Grok) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | AI re-teach (default `gpt-5-mini`), Whisper transcription, OpenAI TTS |
| `GROQ_API_KEY` (`gsk_…`), `GROQ_MODEL`, `GROQ_VISION_MODEL`, `GROQ_BASE_URL` | Groq (default `openai/gpt-oss-120b`, vision `qwen/qwen3.8-27b`); Whisper transcription when there is no OpenAI key |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google Gemini via its OpenAI-compatible API (default `gemini-3.1-flash-lite`) |
| `XAI_API_KEY` (`xai-…`), `XAI_MODEL` | xAI Grok (default `grok-4-fast-non-reasoning`) — not the same as Groq |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Read aloud with ElevenLabs (else OpenAI TTS, else the browser voice) |
| `DEMO_MODE=1` | Offline demo: bundled AI fixtures for the demo lecture, never the network |
| `AI_RATE_LIMIT`, `AI_MAX_CONCURRENCY`, `AI_PREFETCH` | Cost controls (fresh generations per session per 10 min, calls in flight, warm-up) |
| `DATABASE_URL` | Postgres / Tiger Data instead of SQLite (`pglite:<dir>` for an embedded local Postgres) |
| `INKLING_DB_PATH`, `INKLING_UPLOAD_DIR` | SQLite file and upload folder (defaults `data/inkling.db`, `data/uploads`) |

## Sponsor tech

### Notability

Notability Pro was my research and design notebook during the build. I recorded the idea and the
prior-art check that led to Inkling there, wrote up and drew the pipeline (capture → save → analyze →
re-teach → review → compare) on the canvas, and sketched the core idea: an erased stroke kept as
ghost ink. To study the lecture, I imported MIT 18.01 Lecture 4 from YouTube, read it with Smart
Notes, and used Note Chat to confirm the typical chain-rule mistake (`sin(x²)` → `cos(x²)`, missing
the inner `2x`), which is the correction the demo is built around.

| Idea and prior-art check | Architecture notes |
| --- | --- |
| ![Inkling idea and problem note in Notability](notability-screenshots/01-idea-and-problem.png) | ![Inkling architecture note in Notability](notability-screenshots/02-architecture.png) |
| **Pipeline and ghost-ink sketch on the canvas** | **MIT 18.01 Lecture 4: YouTube-to-notes and Smart Notes** |
| ![Architecture diagram drawn on the Notability canvas](notability-screenshots/05-architecture-diagram-canvas.png) | ![MIT 18.01 lecture transcript with Smart Notes in Notability](notability-screenshots/03-youtube-lecture-smart-notes.png) |
| **Note Chat: the chain-rule mistake** | |
| ![Note Chat answering where students get confused about the chain rule](notability-screenshots/04-note-chat-chain-rule-mistake.png) | |

In the app: **Compare with Notability** takes a Notability PDF export of the same notes and lays
Inkling's process over the final page (side by side, or an overlay slider), with the count of what the
final page hides — erased attempts, corrections, open gaps, breakthroughs.

### OpenAI · Groq · Google Gemini · xAI Grok

One OpenAI-compatible client (`lib/ai/compat.ts`) with strict JSON-schema output, a repair retry, a
10 s deadline, per-session rate limits and a result cache. With no `AI_PROVIDER`, the first key found
wins: OpenAI → Groq → Gemini → Grok. `DEMO_MODE=1` (what `npm run demo` sets) never calls any of them.
Vision reads the before/after crops of a
correction ("what you changed", the likely misconception); text writes the ≤80-word re-explanation
and a 4-option check question (the answer is graded on the server and never sent to the client
first). Lecture text and handwriting are treated as untrusted data in every prompt.

**Groq vs Grok.** Groq (GroqCloud, `GROQ_API_KEY=gsk_…`, `lib/ai/groq.ts`) and xAI's Grok
(`XAI_API_KEY=xai-…`, `lib/ai/grok.ts`) are different companies and different keys. On Groq:

- Text uses `GROQ_MODEL` (default `openai/gpt-oss-120b`: a production model with strict JSON-schema
  structured outputs, asked for low reasoning effort). A model without strict structured outputs
  falls back to JSON mode, with the same validators and repair retry.
- Handwriting revisions use `GROQ_VISION_MODEL` (default `qwen/qwen3.8-27b`, Groq's vision model, a
  preview model). If it is turned off (`none`) or rejects the request, the next provider with a key
  reads the revision; without one, the moment shows "Couldn't read this revision right now" and
  the text help still works.
- Lecture transcription uses Groq Whisper (`whisper-large-v3-turbo`, word timestamps) when
  `OPENAI_API_KEY` is not set. Direct uploads are capped at 25 MB; larger files get a clear error
  (upload captions, or compress the audio to 16 kHz mono).
- Read aloud is unchanged (ElevenLabs → OpenAI → browser voice): Groq's text-to-speech (Orpheus,
  preview) takes at most 200 characters per request and returns WAV only, which doesn't fit the
  cached MP3 re-explanations.

To go live with Groq: put `GROQ_API_KEY=gsk_…` in `.env.local`, restart `npm run dev`, and open
`/about` — it shows `Groq · openai/gpt-oss-120b`.

### ElevenLabs

**Read aloud** speaks the re-explanation with an ElevenLabs voice (`lib/ai/tts.ts`), cached per text.

### Tiger Data (TimescaleDB)

Inkling stores everything in a local SQLite file by default (`data/inkling.db`, no setup). To store
it in Postgres on [Tiger Data](https://www.tigerdata.com/) (Timescale Cloud) instead:

1. Create a free service in the Tiger Cloud console and copy its connection string.
2. Put it in `.env.local` (see `.env.local.example`):
   ```bash
   DATABASE_URL=postgres://tsdbadmin:YOUR_PASSWORD@YOUR_SERVICE.YOUR_PROJECT.tsdb.cloud.timescale.com:PORT/tsdb?sslmode=require
   ```
3. Restart `npm run dev`. Tables are created on first use (versioned migrations in
   `schema_migrations`), and the bundled demo lecture is seeded. `npm run seed:demo` seeds the demo there too.
4. Open `/about` (or `/api/health`): it shows `Postgres + TimescaleDB (Tiger Data)`.

Connections to any Postgres that is not on this machine use TLS by default, even without
`sslmode` (or with `prefer` / `allow`): `require` semantics, certificate not verified. Plaintext is
used only for local servers (`localhost`, `127.0.0.0/8`, `::1`, unix sockets) or with an explicit
`sslmode=disable`; `sslmode=verify-full` / `verify-ca` also verify the certificate.

What TimescaleDB is used for (`lib/dbPostgres.ts`):

- **`ink_samples` hypertable.** Every live stroke also gets one summary row: speed, mean pressure,
  ink length and erased, with its time column `lecture_ts` = 2000-01-01 + the stroke's lecture ms.
  It is written in the same transaction as the stroke upsert.
- **`time_bucket` window stats.** `GET /api/sessions/<id>/ink-stats?windowMs=10000` gives
  per-window stroke count, erased count, total ink, median speed (`percentile_cont`) and mean pen
  pressure.
- **Continuous aggregate `ink_lecture_hotspots`.** It holds class-wide ink per 30 s of a lecture, is
  real-time, and is refreshed every minute by a policy. `GET /api/lectures/<id>/hotspots` reads it, and
  **Progress** draws it as **"Where the class slowed down"** (erasing per 30 s over every session of
  the lecture); `/about` names the query that produced it.

Without the extension (plain Postgres, or `DATABASE_URL=pglite:memory` for a local run with no
server), the same queries run with `date_bin` on a plain table and give identical results;
`/api/health` shows `"timescale": false`. On SQLite the same numbers are computed in TypeScript.

## Tests

```bash
npx tsc --noEmit && npm run lint
npx vitest run                     # unit + integration, on SQLite and on Postgres (embedded PGlite)
npx playwright test                # e2e: dev server on :3100 (SQLite) + the production demo on :3101
                                   # (projects: chromium, ai, demo, landing — /welcome with LANDING_AI_DISABLED=1)
INKLING_TEST_PG=1 npx playwright test   # the same e2e suite on the Postgres repository (PGlite)
TIMESCALE_TEST_URL=<throwaway service URL> npx vitest run lib/__tests__/dbTimescale.test.ts
```

Playwright starts its own servers (ports 3100 and 3101 must be free); they build into their own
folders (`INKLING_DIST_DIR=.next-e2e`, `.next-e2e-demo`), so they can run next to an everyday `npm run dev`. The `demo` project seeds a fresh
database, builds for production when the source changed, and runs `e2e/demo.spec.ts` offline;
screenshots of each stop go to `screenshots/demo-*.png`.

## Notes

- `npm run seed:demo` runs TypeScript with `tsx` and generates the PDF with `pdf-lib` — both dev
  dependencies, so seed from a normal `npm install` (not `--omit=dev`). The app itself never needs them.
- `AGENTS.md` is generated by Next.js 16 (`next dev`); it points agents at the bundled Next docs.
