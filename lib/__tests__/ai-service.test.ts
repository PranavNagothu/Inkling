import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SCENARIO_TIMES, buildPhase2Scenario } from '../../e2e/fixtures/phase2-scenario';
import { createFakeProvider } from '../ai/fake';
import { createRateLimiter, createSemaphore, createSingleFlight } from '../ai/limits';
import { AiInvalidOutputError, type AiProvider } from '../ai/types';
import type { EraseEvent, Stroke, TimelineEvent } from '../types';

// Integration: AI help / revision reading / labels / TTS over a throwaway SQLite file. Providers are
// the deterministic fake (or spies around it); fetch is always a mock — never the network.
const dir = mkdtempSync(join(tmpdir(), 'inkling-ai-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');

let db: ReturnType<typeof import('../db')['getDb']>;
let analyze: typeof import('../analyze');
let service: typeof import('../ai/service');

beforeAll(async () => {
  db = (await import('../db')).getDb();
  analyze = await import('../analyze');
  service = await import('../ai/service');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FAKE_ENV = { AI_PROVIDER: 'fake' };
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')}`;
const PNG3 = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString('base64')}`;
const PNG2 = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]).toString('base64')}`;

type Build = (id: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] };

/** A copy of the demo lecture (same transcript, own id), so AI labels stored for it start empty. */
async function copyLecture(title: string): Promise<string> {
  const demo = (await db.getLecture('demo-chain-rule'))!;
  const lecture = await db.createLecture({
    title,
    courseId: 'calc1',
    mediaPath: 'public/demo/lecture.wav',
    mediaType: 'audio',
    mime: 'audio/wav',
    durationMs: 360_000,
    words: demo.words,
    transcriptSource: 'captions',
  });
  return lecture.id;
}

let copies = 0;
/** Seeds + analyses the Phase 2 scenario (one correction, one gap) on its own lecture copy by default. */
async function seed(build: Build = (id) => buildPhase2Scenario(id), studentId = 'st-ai', lectureId?: string) {
  lectureId ??= await copyLecture(`Chain rule copy ${++copies}`);
  const session = await db.createSession({ lectureId, courseId: 'calc1', title: 't', studentId });
  const { strokes, eraseEvents } = build(session.id);
  await db.upsertStrokes(session.id, strokes);
  await db.addEraseEvents(session.id, eraseEvents);
  const result = (await analyze.analyzeSession(session.id))!;
  const find = (type: TimelineEvent['type']) => result.events.find((e) => e.type === type)!;
  return { id: session.id, events: result.events, corrected: find('misconception_corrected'), gap: find('unresolved_gap') };
}

/** Fresh limits per test so counts don't leak between tests. */
const limits = (rate = 50) => ({
  rate: createRateLimiter({ limit: rate, windowMs: 600_000 }),
  semaphore: createSemaphore(2),
  flight: createSingleFlight(),
});

function spy(base: AiProvider = createFakeProvider()) {
  return {
    name: base.name,
    model: base.model,
    helpFor: vi.fn(base.helpFor),
    readRevision: vi.fn(base.readRevision),
    labelConcept: vi.fn(base.labelConcept),
  } satisfies AiProvider;
}

describe('help', () => {
  it('503 when no provider is configured (and nothing is stored)', async () => {
    const { gap } = await seed();
    const svc = service.createAiService({ env: {}, limits: limits() });
    expect(await svc.getHelp(gap.id)).toMatchObject({ ok: false, status: 503, error: 'AI not configured' });
    expect((await db.getEvent(gap.id))!.help).toBeUndefined();
    expect(svc.status()).toMatchObject({ enabled: false, mode: 'off' });
  });

  it('404 for an unknown moment', async () => {
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits() });
    expect(await svc.getHelp('nope')).toMatchObject({ ok: false, status: 404 });
  });

  it('generates lazily, stores the full card on the event, and sends the client no answer', async () => {
    const { gap } = await seed();
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const res = await svc.getHelp(gap.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.help.mcq.options).toHaveLength(4);
    expect(res.help).toMatchObject({ source: 'ai', provider: 'fake' });
    expect(JSON.stringify(res.help)).not.toMatch(/answerIdx|"why"/);
    expect(res.event.help).toBeUndefined();
    const stored = (await db.getEvent(gap.id))!.help!;
    expect(stored.mcq.answerIdx).toBeGreaterThanOrEqual(0);
    expect(stored.source).toBe('ai');

    // Second open: served from the event, no provider call.
    await svc.getHelp(gap.id);
    expect(provider.helpFor).toHaveBeenCalledTimes(1);
  });

  it('caches by input: the same moment in another session reuses the result (no second call)', async () => {
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const lectureId = await copyLecture('Shared cache');
    const a = await seed(undefined, 'st-cache', lectureId);
    const b = await seed(undefined, 'st-cache-2', lectureId);
    const ra = await svc.getHelp(a.corrected.id);
    const rb = await svc.getHelp(b.corrected.id);
    expect(provider.helpFor).toHaveBeenCalledTimes(1);
    expect(ra.ok && rb.ok && rb.help).toEqual(ra.ok && ra.help);
  });

  it('concurrent opens of one moment share a single generation', async () => {
    const { gap } = await seed(undefined, 'st-flight');
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const [x, y] = await Promise.all([svc.getHelp(gap.id), svc.getHelp(gap.id)]);
    expect(x.ok && y.ok).toBe(true);
    expect(provider.helpFor).toHaveBeenCalledTimes(1);
  });

  it('invalid model output → safe fallback card (not cached, regenerated next time)', async () => {
    const { gap } = await seed(undefined, 'st-fallback');
    const provider = spy();
    provider.helpFor.mockRejectedValue(new AiInvalidOutputError('bad', ['mcq.options must have exactly 4 items']));
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const res = await svc.getHelp(gap.id);
    expect(res.ok && res.help.source).toBe('fallback');
    expect((await db.getEvent(gap.id))!.help!.source).toBe('fallback');
    provider.helpFor.mockReset();
    provider.helpFor.mockImplementation(createFakeProvider().helpFor);
    const again = await svc.getHelp(gap.id);
    expect(again.ok && again.help.source).toBe('ai');
    expect(provider.helpFor).toHaveBeenCalledTimes(1);
  });

  it('rate-limits fresh generations per session (429 with retry-after)', async () => {
    const { gap, corrected } = await seed(undefined, 'st-rate');
    const svc = service.createAiService({ env: FAKE_ENV, provider: spy(), limits: limits(1) });
    expect((await svc.getHelp(corrected.id)).ok).toBe(true);
    const limited = await svc.getHelp(gap.id);
    expect(limited).toMatchObject({ ok: false, status: 429 });
    expect(!limited.ok && limited.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts a fresh concept-label generation against the session rate limit', async () => {
    const lectureId = await copyLecture('Label rate limit');
    const s = await seed(undefined, 'st-label-rate', lectureId);
    // Its own model: no cached help or labels from earlier tests.
    const provider = { ...spy(), model: 'fake-label-rate' };
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(2) });
    // Help (1) + its concept's label (2) use the whole budget…
    expect((await svc.getHelp(s.corrected.id)).ok).toBe(true);
    expect(provider.labelConcept).toHaveBeenCalledTimes(1);
    // …so the next fresh generation of this session is refused.
    expect(await svc.getHelp(s.gap.id)).toMatchObject({ ok: false, status: 429 });
  });

  it('skips the label (keeps the transcript one) when the session is out of budget', async () => {
    const lectureId = await copyLecture('Label over budget');
    const s = await seed(undefined, 'st-label-budget', lectureId);
    const provider = { ...spy(), model: 'fake-label-budget' };
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(1) });
    const res = await svc.getHelp(s.corrected.id);
    expect(res.ok).toBe(true);
    expect(provider.labelConcept).not.toHaveBeenCalled();
    expect(res.ok && res.event.conceptLabel).toBe(s.corrected.conceptLabel);
    expect((await db.getConceptLabels(lectureId)).size).toBe(0);
  });

  it('upgrades the concept label (not the id), everywhere, and re-analysis keeps it', async () => {
    const lectureId = await copyLecture('Label upgrade');
    const s = await seed(undefined, 'st-label', lectureId);
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits() });
    const before = s.gap;
    const res = await svc.getHelp(before.id);
    if (!res.ok) throw new Error('help failed');
    expect(res.event.conceptId).toBe(before.conceptId);
    expect(res.event.conceptLabel).not.toBe(before.conceptLabel);
    expect(res.event.conceptLabel!.split(' ').length).toBeLessThanOrEqual(4);
    const again = (await analyze.analyzeSession(s.id))!.events.find((e) => e.id === before.id)!;
    expect(again).toMatchObject({ conceptId: before.conceptId, conceptLabel: res.event.conceptLabel });
    const labels = await db.getConceptLabels(lectureId);
    expect(labels.get(before.conceptId!)).toBe(res.event.conceptLabel);
  });

  it('keeps the transcript label when labelling fails', async () => {
    const lectureId = await copyLecture('Label failure');
    const s = await seed(undefined, 'st-label-fail', lectureId);
    // Another model: earlier tests' cached labels (same sentence) must not apply.
    const provider = { ...spy(), model: 'fake-failing' };
    provider.labelConcept.mockRejectedValue(new Error('down'));
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const res = await svc.getHelp(s.corrected.id);
    expect(provider.labelConcept).toHaveBeenCalledTimes(1);
    expect(res.ok && res.event.conceptLabel).toBe(s.corrected.conceptLabel);
    expect((await db.getConceptLabels(lectureId)).size).toBe(0);
  });
});

describe('revision reading', () => {
  it('stores the reading on the revision, serves it again without a call, and keeps it through re-analysis', async () => {
    const s = await seed(undefined, 'st-vision');
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    const res = await svc.readRevision(s.corrected.id, { beforePng: PNG, afterPng: PNG2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revision.vision).toMatchObject({ cosmetic: false });
    expect(res.revision.vision!.before).toBeTruthy();
    expect((await db.getRevision(s.corrected.revisionId!))!.vision).toEqual(res.revision.vision);
    await svc.readRevision(s.corrected.id, { beforePng: PNG, afterPng: PNG2 });
    expect(provider.readRevision).toHaveBeenCalledTimes(1);
    const t = (await analyze.analyzeSession(s.id))!;
    expect(t.revisions.find((r) => r.id === s.corrected.revisionId)!.vision).toEqual(res.revision.vision);
  });

  it('a cosmetic reading hides the moment on the next analysis', async () => {
    const s = await seed(undefined, 'st-cosmetic');
    const provider = spy();
    provider.readRevision.mockResolvedValue({ before: 'x', after: 'x', misconception: '', conceptLabel: 'Neater handwriting', cosmetic: true });
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    expect((await svc.readRevision(s.corrected.id, { beforePng: PNG, afterPng: PNG })).ok).toBe(true);
    const t = (await analyze.analyzeSession(s.id))!;
    expect(t.events.some((e) => e.type === 'misconception_corrected')).toBe(false);
  });

  it('refuses moments without a revision, and 503 without a provider', async () => {
    const s = await seed(undefined, 'st-vision-2');
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits() });
    expect(await svc.readRevision(s.gap.id, { beforePng: PNG, afterPng: PNG })).toMatchObject({ ok: false, status: 400 });
    const off = service.createAiService({ env: {}, limits: limits() });
    expect(await off.readRevision(s.corrected.id, { beforePng: PNG, afterPng: PNG })).toMatchObject({ ok: false, status: 503 });
  });

  it('a provider failure is a quiet 502 (nothing stored)', async () => {
    const s = await seed(undefined, 'st-vision-3');
    const provider = spy();
    provider.readRevision.mockRejectedValue(new Error('down'));
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    expect(await svc.readRevision(s.corrected.id, { beforePng: PNG3, afterPng: PNG3 })).toMatchObject({ ok: false, status: 502 });
    expect((await db.getRevision(s.corrected.revisionId!))!.vision).toBeUndefined();
  });
});

describe('DEMO_MODE', () => {
  it('serves fixture cards for the demo lecture and never calls the network, even with keys set', async () => {
    const s = await seed(undefined, 'st-demo', 'demo-chain-rule');
    const fetchSpy = vi.fn(async () => {
      throw new Error('network must not be used in DEMO_MODE');
    });
    const svc = service.createAiService({ env: { DEMO_MODE: '1', OPENAI_API_KEY: 'sk-x' }, fetch: fetchSpy as unknown as typeof fetch, limits: limits() });
    const res = await svc.getHelp(s.gap.id);
    expect(res.ok && res.help).toMatchObject({ source: 'demo', provider: 'demo' });
    expect(res.ok && res.event.conceptLabel).toBe('Chain rule recipe');
    const reading = await svc.readRevision(s.corrected.id, { beforePng: PNG, afterPng: PNG });
    expect(reading.ok && reading.revision.vision!.conceptLabel).toBe('Powers of polynomials');
    expect((await svc.speak(s.gap.id)).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(SCENARIO_TIMES.gapWindowMs).toBe(220_000);
  });
});

describe('text to speech', () => {
  it('503 without a voice key; 409 before there is an explanation', async () => {
    const s = await seed(undefined, 'st-tts-0');
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits() });
    expect(await svc.speak(s.gap.id)).toMatchObject({ ok: false, status: 409 });
    await svc.getHelp(s.gap.id);
    expect(await svc.speak(s.gap.id)).toMatchObject({ ok: false, status: 503 });
    expect(await svc.speak('nope')).toMatchObject({ ok: false, status: 404 });
  });

  it('synthesises once, then serves the mp3 from the disk cache', async () => {
    const s = await seed(undefined, 'st-tts');
    await service.createAiService({ env: FAKE_ENV, limits: limits() }).getHelp(s.gap.id);
    const ttsDir = join(dir, 'tts');
    const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 5, 6]);
    const fetchMock = vi.fn(async () => new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }));
    const svc = service.createAiService({
      env: { OPENAI_API_KEY: 'sk-test', ELEVENLABS_API_KEY: '' },
      fetch: fetchMock as unknown as typeof fetch,
      limits: limits(),
      ttsDir,
    });
    const first = await svc.speak(s.gap.id);
    expect(first).toMatchObject({ ok: true, voice: 'OpenAI · alloy' });
    expect(first.ok && Array.from(first.audio)).toEqual(Array.from(audio));
    expect(existsSync(ttsDir) && readdirSync(ttsDir).filter((f) => f.endsWith('.mp3'))).toHaveLength(1);
    const second = await svc.speak(s.gap.id);
    expect(second.ok && Array.from(second.audio)).toEqual(Array.from(audio));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('prefetch', () => {
  it('prepares help for up to N moments of a session, gaps first', async () => {
    const s = await seed(undefined, 'st-prefetch');
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits() });
    expect(await svc.prefetchHelp(s.id, 1)).toBe(1);
    expect((await db.getEvent(s.gap.id))!.help).toBeTruthy();
    expect((await db.getEvent(s.corrected.id))!.help).toBeUndefined();
  });
});

describe('status().tts: whether the server has a voice (so Read aloud can decide on the first tap)', () => {
  it('is true only when a TTS voice is configured and AI is not switched off', () => {
    const tts = (env: Record<string, string>) => service.createAiService({ env, limits: limits() }).status().tts;
    expect(tts({})).toBe(false);
    expect(tts(FAKE_ENV)).toBe(false);
    expect(tts({ ELEVENLABS_API_KEY: 'el-key' })).toBe(true);
    expect(tts({ OPENAI_API_KEY: 'sk-key' })).toBe(true);
    expect(tts({ OPENAI_API_KEY: 'sk-key', INKLING_DISABLE_AI: '1' })).toBe(false);
    expect(tts({ ELEVENLABS_API_KEY: 'el-key', DEMO_MODE: '1' })).toBe(false);
  });
});

describe('test-only "x-inkling-ai: off" header', () => {
  const off = new Headers({ 'x-inkling-ai': 'off' });

  it('turns AI off outside production, and only ever off', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AI_PROVIDER', 'fake');
    try {
      expect(service.aiDisabledByRequest(off)).toBe(true);
      expect(service.aiService(off).status()).toMatchObject({ enabled: false, mode: 'off' });
      expect(service.aiDisabledByRequest(new Headers({ 'x-inkling-ai': 'openai' }))).toBe(false);
      expect(service.aiService(new Headers()).status()).toMatchObject({ enabled: true, mode: 'fake' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is ignored in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AI_PROVIDER', 'fake');
    try {
      expect(service.aiDisabledByRequest(off)).toBe(false);
      expect(service.aiService(off).status()).toMatchObject({ enabled: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
