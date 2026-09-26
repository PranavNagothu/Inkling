import "server-only";

// Phase 5 AI features, server side. Everything is lazy (generated the first time a moment is
// opened) and cached twice: per input in ai_cache (sha256 of provider|model|kind|input, so the same
// moment in another session or after re-analysis costs nothing) and per moment on the event /
// revision row. Fresh generations are rate-limited per session, at most 2 run at once, and
// concurrent requests for the same result share one call. DEMO_MODE serves bundled fixtures and
// never touches the network.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import demoFixturesJson from "@/public/demo/ai-cache.json";
import { createConceptTagger } from "../concepts";
import { getDb } from "../db";
import { publicHelp, toClientEvent } from "../events";
import { attachHistory, withLectureLock } from "../gaps";
import { getSessionLecture } from "../lecture";
import { formatClock } from "../time";
import type { HelpCard, PublicHelpCard, Revision, RevisionReading, Session, TimelineEvent, TranscriptWord } from "../types";
import { aiCacheKey, sha256 } from "./cache";
import type { Env } from "./compat";
import { demoEntryFor, demoHelpCard, parseDemoFixtures, type DemoFixtures } from "./demo";
import { fallbackHelpCard } from "./fallback";
import { createRateLimiter, createSemaphore, createSingleFlight, type RateLimiter, type Semaphore, type SingleFlight } from "./limits";
import { aiStatusFrom, selectProvider, type AiStatus, type ProviderSelection } from "./select";
import { selectTts, synthesizeSpeech, ttsCacheKey, ttsLabel } from "./tts";
import type { AiProvider, HelpContext } from "./types";
import { validateConceptLabel, validateHelpCard, validateRevisionReading } from "./validate";

export interface AiLimits {
  rate: RateLimiter;
  semaphore: Semaphore;
  flight: SingleFlight;
}

export interface AiServiceDeps {
  /** Defaults to process.env, read on every call (keys added to .env.local go live on reload). */
  env?: Env;
  /** Used by network providers and TTS (tests pass a mock). */
  fetch?: typeof fetch;
  /** Overrides the selected provider (tests). The mode still comes from `env`. */
  provider?: AiProvider;
  limits?: AiLimits;
  /** Where synthesised speech is cached (default data/tts, or INKLING_TTS_DIR). */
  ttsDir?: string;
}

export type Fail = { ok: false; status: number; error: string; retryAfterMs?: number };
export type HelpResult = { ok: true; help: PublicHelpCard; event: TimelineEvent } | Fail;
export type ReadRevisionResult = { ok: true; revision: Revision; event: TimelineEvent } | Fail;
export type SpeakResult = { ok: true; audio: Uint8Array; voice: string } | Fail;

const NOT_CONFIGURED: Fail = { ok: false, status: 503, error: "AI not configured" };

const intEnv = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// Shared across requests (and Next dev hot reloads).
const g = globalThis as unknown as { __inklingAiLimits?: AiLimits; __inklingDemoFixtures?: DemoFixtures };
function sharedLimits(env: Env): AiLimits {
  return (g.__inklingAiLimits ??= {
    // Fresh generations per session per 10 minutes (cached results are free).
    rate: createRateLimiter({ limit: intEnv(env.AI_RATE_LIMIT, 30, 1, 10_000), windowMs: 10 * 60_000 }),
    semaphore: createSemaphore(intEnv(env.AI_MAX_CONCURRENCY, 2, 1, 16)),
    flight: createSingleFlight(),
  });
}
const demoFixtures = () => (g.__inklingDemoFixtures ??= parseDemoFixtures(demoFixturesJson));

/** Words spoken in [startMs, endMs]. */
const textBetween = (words: TranscriptWord[], startMs: number, endMs: number) =>
  words
    .filter((w) => w.startMs >= startMs && w.endMs <= endMs + 1)
    .map((w) => w.w)
    .join(" ");

export function createAiService(deps: AiServiceDeps = {}) {
  const env = () => deps.env ?? process.env;
  const limits = () => deps.limits ?? sharedLimits(env());
  const select = (): ProviderSelection => {
    const sel = selectProvider(env(), { fetch: deps.fetch });
    return deps.provider && sel.provider ? { ...sel, provider: deps.provider } : sel;
  };
  const ttsDir = () => deps.ttsDir ?? resolve(/*turbopackIgnore: true*/ process.cwd(), env().INKLING_TTS_DIR || "data/tts");

  async function load(eventId: string): Promise<{ event: TimelineEvent; session: Session } | Fail> {
    const db = getDb();
    const event = await db.getEvent(eventId);
    if (!event) return { ok: false, status: 404, error: "moment not found" };
    const session = await db.getSession(event.sessionId);
    if (!session) return { ok: false, status: 404, error: "session not found" };
    return { event, session };
  }

  /** The moment as the client sees it now (with history, without the stored help). */
  async function clientEvent(session: Session, eventId: string): Promise<TimelineEvent> {
    const event = (await getDb().getEvent(eventId))!;
    const [withHistory] = await attachHistory(session, [event]);
    return toClientEvent(withHistory);
  }

  function rateLimited(session: Session): Fail | null {
    const { rate } = limits();
    if (rate.take(session.id)) return null;
    return {
      ok: false,
      status: 429,
      error: "Too many AI requests for this session — try again in a few minutes.",
      retryAfterMs: rate.retryAfterMs(session.id),
    };
  }

  /** Cache lookup, else a limited, de-duplicated provider call whose valid result is cached. */
  async function cachedCall<T>(
    kind: string,
    provider: AiProvider,
    input: unknown,
    validate: (v: unknown) => { ok: true; value: T } | { ok: false },
    call: () => Promise<T>,
    /** Every fresh generation (help, reading, label) counts against this session's AI budget. */
    session: Session,
  ): Promise<{ ok: true; value: T } | Fail> {
    const db = getDb();
    const key = aiCacheKey({ provider: provider.name, model: provider.model, kind, input });
    const hit = await db.getAiCache(key);
    if (hit) {
      const v = validate(hit.value);
      if (v.ok) return v;
    }
    const limited = rateLimited(session);
    if (limited) return limited;
    const { semaphore, flight } = limits();
    const value = await flight.run(key, async () => {
      const fresh = await semaphore.run(call);
      await db.putAiCache({ key, kind, provider: provider.name, model: provider.model, value: fresh });
      return fresh;
    });
    return { ok: true, value };
  }

  async function helpContext(event: TimelineEvent, lectureTitle: string, lectureId: string, words: TranscriptWord[]): Promise<HelpContext> {
    const revision = event.revisionId ? await getDb().getRevision(event.revisionId) : null;
    // The transcript-derived label (not a stored AI label), so cache keys don't move when labels improve.
    const concept = event.conceptId ? createConceptTagger(lectureId, words).conceptFor(event.lectureMs) : null;
    return {
      lectureTitle,
      conceptLabel: concept?.label ?? event.conceptLabel ?? null,
      excerpt: event.evidence.excerpt,
      momentType: event.type,
      clock: formatClock(event.lectureMs),
      misconception: revision?.vision && !revision.vision.cosmetic ? revision.vision.misconception || null : null,
    };
  }

  /**
   * Gives the moment's concept an AI label (lazily, once per concept; cached). Ids never change;
   * on any failure — or when the session is out of AI budget: a fresh label counts against the
   * same per-session rate limit as help cards — the transcript-derived label stays.
   */
  async function upgradeConceptLabel(
    event: TimelineEvent,
    lectureId: string,
    words: TranscriptWord[],
    sel: ProviderSelection,
    session: Session,
  ) {
    if (!event.conceptId || !sel.provider) return;
    const db = getDb();
    try {
      if (sel.mode === "demo") {
        const entry = demoEntryFor(demoFixtures(), lectureId, event.lectureMs);
        if (entry) {
          if ((await db.getConceptLabels(lectureId)).get(event.conceptId) !== entry.label) {
            await db.setConceptLabel(lectureId, event.conceptId, entry.label);
          }
          return;
        }
      }
      if ((await db.getConceptLabels(lectureId)).has(event.conceptId)) return;
      const segment = createConceptTagger(lectureId, words).conceptFor(event.lectureMs);
      if (segment.id !== event.conceptId) return; // transcript changed since analysis; next analysis re-tags
      const text = textBetween(words, segment.startMs, segment.endMs);
      if (!text) return; // a "Moment at mm:ss" bucket: nothing to name
      const provider = sel.provider;
      const res = await cachedCall(
        "label",
        provider,
        { text },
        (v) => validateConceptLabel({ label: v }),
        () => provider.labelConcept(text),
        session,
      );
      if (res.ok) await db.setConceptLabel(lectureId, event.conceptId, res.value);
    } catch (err) {
      console.warn("concept label upgrade failed", err instanceof Error ? err.message : err);
    }
  }

  async function getHelp(eventId: string): Promise<HelpResult> {
    const loaded = await load(eventId);
    if ("ok" in loaded) return loaded;
    const { event, session } = loaded;
    if (event.help && event.help.source !== "fallback") {
      return { ok: true, help: publicHelp(event.help), event: await clientEvent(session, eventId) };
    }
    const sel = select();
    if (!sel.provider) return NOT_CONFIGURED;
    const provider = sel.provider;
    const { lecture, words } = await getSessionLecture(session.lectureId);

    let help: HelpCard | null = null;
    if (sel.mode === "demo") {
      const entry = demoEntryFor(demoFixtures(), lecture.id, event.lectureMs);
      if (entry) help = demoHelpCard(entry);
    }
    if (!help) {
      const ctx = await helpContext(event, lecture.title, lecture.id, words);
      try {
        const res = await cachedCall("help", provider, ctx, validateHelpCard, () => provider.helpFor(ctx), session);
        if (!res.ok) return res;
        help = { ...res.value, source: sel.mode === "demo" ? "demo" : "ai", provider: provider.name };
      } catch (err) {
        // Invalid twice, timed out, or the provider is down: a safe card now, a fresh try next open.
        console.warn(`help generation failed (${provider.name})`, err instanceof Error ? err.message : err);
        help = { ...fallbackHelpCard(ctx), source: "fallback", provider: provider.name };
      }
    }

    const card = help;
    await withLectureLock(session.studentId, session.lectureId, () => getDb().setEventHelp(event.id, card));
    await upgradeConceptLabel(event, lecture.id, words, sel, session);
    return { ok: true, help: publicHelp(card), event: await clientEvent(session, eventId) };
  }

  async function readRevision(eventId: string, pngs: { beforePng: string; afterPng: string }): Promise<ReadRevisionResult> {
    const loaded = await load(eventId);
    if ("ok" in loaded) return loaded;
    const { event, session } = loaded;
    if (!event.revisionId) return { ok: false, status: 400, error: "this moment has no revision to read" };
    const db = getDb();
    const revision = await db.getRevision(event.revisionId);
    if (!revision) return { ok: false, status: 404, error: "revision not found" };
    if (revision.vision) return { ok: true, revision, event: await clientEvent(session, eventId) };
    const sel = select();
    if (!sel.provider) return NOT_CONFIGURED;
    const provider = sel.provider;

    let reading: RevisionReading | null = null;
    if (sel.mode === "demo") reading = demoEntryFor(demoFixtures(), session.lectureId, event.lectureMs)?.revision ?? null;
    if (!reading) {
      const input = { beforePng: pngs.beforePng, afterPng: pngs.afterPng, excerpt: event.evidence.excerpt };
      // Key on image digests, not megabytes of base64.
      const keyInput = { before: sha256(input.beforePng), after: sha256(input.afterPng), excerpt: input.excerpt };
      try {
        const res = await cachedCall("revision", provider, keyInput, validateRevisionReading, () => provider.readRevision(input), session);
        if (!res.ok) return res;
        reading = res.value;
      } catch (err) {
        console.warn(`revision reading failed (${provider.name})`, err instanceof Error ? err.message : err);
        return { ok: false, status: 502, error: "Couldn’t read this revision right now." };
      }
    }
    await db.setRevisionVision(revision.id, reading);
    return { ok: true, revision: { ...revision, vision: reading }, event: await clientEvent(session, eventId) };
  }

  async function speak(eventId: string): Promise<SpeakResult> {
    const loaded = await load(eventId);
    if ("ok" in loaded) return loaded;
    const { event, session } = loaded;
    const text = event.help?.reexplain;
    if (!text) return { ok: false, status: 409, error: "This moment has no explanation yet." };
    const { tts, reason } = selectTts(env());
    if (!tts) return { ok: false, status: 503, error: `No voice configured (${reason}).` };

    const dir = ttsDir();
    // Hex digest: safe as a file name.
    const file = join(dir, `${ttsCacheKey(tts, text)}.mp3`);
    try {
      return { ok: true, audio: new Uint8Array(await readFile(file)), voice: ttsLabel(tts) };
    } catch {
      // not cached yet
    }
    const limited = rateLimited(session);
    if (limited) return limited;
    try {
      const { semaphore, flight } = limits();
      const audio = await flight.run(file, () =>
        semaphore.run(async () => {
          const bytes = await synthesizeSpeech(tts, text, { fetch: deps.fetch });
          await mkdir(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, bytes);
          await rename(tmp, file);
          return bytes;
        }),
      );
      return { ok: true, audio, voice: ttsLabel(tts) };
    } catch (err) {
      console.warn(`speech synthesis failed (${tts.kind})`, err instanceof Error ? err.message : err);
      return { ok: false, status: 502, error: "Couldn’t make the audio right now." };
    }
  }

  /** Background warm-up after analysis: help for up to `limit` moments (gaps first). Returns how many. */
  async function prefetchHelp(sessionId: string, limit = 3): Promise<number> {
    const stored = (await getDb().getAnalysis(sessionId))?.events ?? [];
    const rank = (e: TimelineEvent) => (e.type === "unresolved_gap" ? 0 : 1);
    const todo = stored
      .filter((e) => !e.help)
      .sort((a, b) => rank(a) - rank(b) || a.lectureMs - b.lectureMs)
      .slice(0, limit);
    let done = 0;
    for (const e of todo) {
      const res = await getHelp(e.id);
      if (!res.ok) break; // not configured / rate-limited: stop quietly
      done++;
    }
    return done;
  }

  return {
    status: (): AiStatus => ({ ...aiStatusFrom(select()), tts: selectTts(env()).tts !== null }),
    getHelp,
    readRevision,
    speak,
    prefetchHelp,
  };
}

export type AiService = ReturnType<typeof createAiService>;

/**
 * Test-only switch: a request carrying `x-inkling-ai: off` is served as if no AI provider were
 * configured. It can only turn AI off (never on or to another provider), and it is ignored in
 * production builds. The e2e suite uses it to run the pre-Phase-5 specs and the "needs an API key"
 * check against the same dev server that serves the fake provider to e2e/phase5.spec.ts.
 */
export const AI_OFF_HEADER = "x-inkling-ai";

export function aiDisabledByRequest(headers: Headers | null | undefined): boolean {
  return process.env.NODE_ENV !== "production" && headers?.get(AI_OFF_HEADER)?.trim().toLowerCase() === "off";
}

/** The app's service: process.env (read per call), shared limits, real fetch. */
export function aiService(headers?: Headers | null): AiService {
  if (aiDisabledByRequest(headers)) {
    return createAiService({ env: { ...process.env, AI_PROVIDER: "", DEMO_MODE: "", INKLING_DISABLE_AI: "1" } });
  }
  return createAiService();
}
