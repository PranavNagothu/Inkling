import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPhase2Scenario } from '../../e2e/fixtures/phase2-scenario';
import { buildMayaSession1 } from '../demoScenario';
import { createFakeProvider } from '../ai/fake';
import { createRateLimiter, createSemaphore, createSingleFlight } from '../ai/limits';
import type { AiProvider } from '../ai/types';
import type { EraseEvent, Stroke, TimelineEvent } from '../types';

// Integration: help cards, check-answer explanations, read aloud and the session recap in the
// student's language, over a throwaway SQLite file. The provider is the deterministic fake (or
// spies around it); fetch is always a mock — never the network.
const dir = mkdtempSync(join(tmpdir(), 'inkling-i18n-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');

let db: ReturnType<typeof import('../db')['getDb']>;
let analyze: typeof import('../analyze');
let service: typeof import('../ai/service');
let gaps: typeof import('../gaps');

beforeAll(async () => {
  db = (await import('../db')).getDb();
  analyze = await import('../analyze');
  service = await import('../ai/service');
  gaps = await import('../gaps');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FAKE_ENV = { AI_PROVIDER: 'fake' };

type Build = (id: string) => { strokes: Stroke[]; eraseEvents: EraseEvent[] };

let copies = 0;
async function copyLecture(): Promise<string> {
  const demo = (await db.getLecture('demo-chain-rule'))!;
  const lecture = await db.createLecture({
    title: `Chain rule copy ${++copies}`,
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

async function seed(build: Build = (id) => buildPhase2Scenario(id), lectureId?: string) {
  lectureId ??= await copyLecture();
  const session = await db.createSession({ lectureId, courseId: 'calc1', title: 't', studentId: `st-i18n-${copies}` });
  const { strokes, eraseEvents } = build(session.id);
  await db.upsertStrokes(session.id, strokes);
  await db.addEraseEvents(session.id, eraseEvents);
  const result = (await analyze.analyzeSession(session.id))!;
  const find = (type: TimelineEvent['type']) => result.events.find((e) => e.type === type)!;
  return { id: session.id, events: result.events, corrected: find('misconception_corrected'), gap: find('unresolved_gap') };
}

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
    localizeHelp: vi.fn(base.localizeHelp!),
    polishRecap: vi.fn(base.polishRecap!),
  } satisfies AiProvider;
}

const noNetwork = vi.fn(async () => {
  throw new Error('network must not be used');
}) as unknown as typeof fetch;

describe('help in the student’s language', () => {
  it('serves a translated card (no answer), keeps the English card stored for grading, and caches per language', async () => {
    const s = await seed();
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(), fetch: noNetwork });

    const es = await svc.getHelp(s.gap.id, 'es');
    if (!es.ok) throw new Error(es.error);
    expect(es.language).toBe('es');
    expect(es.languageFallback).toBeFalsy();
    expect(es.help.reexplain.startsWith('[es] ')).toBe(true);
    expect(es.help.mcq.options.every((o) => o.startsWith('[es] '))).toBe(true);
    expect(es.help.mcq).not.toHaveProperty('answerIdx');
    expect(es.help.mcq).not.toHaveProperty('why');
    expect(JSON.stringify(es)).not.toContain('answerIdx');

    // The stored card (what grading reads) is still the English one.
    const stored = (await db.getEvent(s.gap.id))!.help!;
    expect(stored.reexplain.startsWith('[es]')).toBe(false);
    expect(provider.helpFor).toHaveBeenCalledTimes(1);
    expect(provider.localizeHelp).toHaveBeenCalledTimes(1);

    // Same language again: cached. Another language: one more call. English: no translation call.
    await svc.getHelp(s.gap.id, 'es');
    expect(provider.localizeHelp).toHaveBeenCalledTimes(1);
    const hi = await svc.getHelp(s.gap.id, 'hi');
    expect(hi.ok && hi.help.reexplain.startsWith('[hi] ')).toBe(true);
    expect(provider.localizeHelp).toHaveBeenCalledTimes(2);
    const en = await svc.getHelp(s.gap.id);
    expect(en.ok && en.language).toBe('en');
    expect(en.ok && en.help.reexplain).toBe(stored.reexplain);
    expect(provider.localizeHelp).toHaveBeenCalledTimes(2);
  });

  it('grading is unchanged: the translated options are in the same order, and "why" comes back translated', async () => {
    const s = await seed();
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits(), fetch: noNetwork });
    const es = await svc.getHelp(s.corrected.id, 'es');
    if (!es.ok) throw new Error(es.error);
    const stored = (await db.getEvent(s.corrected.id))!.help!;
    // Option i of the translation is option i of the stored card.
    es.help.mcq.options.forEach((o, i) => expect(o).toBe(`[es] ${stored.mcq.options[i]}`));
    const graded = await gaps.answerCheckQuestion(s.corrected.id, stored.mcq.answerIdx);
    expect(graded.ok && graded.correct).toBe(true);
    expect(await svc.localizedWhy(s.corrected.id, 'es')).toBe(`[es] ${stored.mcq.why}`);
    expect(await svc.localizedWhy(s.corrected.id, 'en')).toBeNull();
    // Never generates: a language that was never opened has nothing to say.
    expect(await svc.localizedWhy(s.corrected.id, 'ko')).toBeNull();
  });

  it('a translation that fails falls back to English, with a note, and is not cached (next open retries)', async () => {
    const s = await seed();
    const provider = spy();
    provider.localizeHelp.mockRejectedValueOnce(new Error('provider down'));
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(), fetch: noNetwork });
    const down = await svc.getHelp(s.gap.id, 'vi');
    const stored = (await db.getEvent(s.gap.id))!.help!;
    expect(down.ok && down.language).toBe('en');
    expect(down.ok && down.languageFallback).toBe(true);
    expect(down.ok && down.help.reexplain).toBe(stored.reexplain);
    const retry = await svc.getHelp(s.gap.id, 'vi');
    expect(retry.ok && retry.language).toBe('vi');
    expect(provider.localizeHelp).toHaveBeenCalledTimes(2);
  });

  it('a session out of AI budget still gets the English card (no 429 for a translation)', async () => {
    const s = await seed();
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits(1), fetch: noNetwork });
    const res = await svc.getHelp(s.gap.id, 'es'); // the English card uses the only fresh generation
    expect(res.ok && res.language).toBe('en');
    expect(res.ok && res.languageFallback).toBe(true);
  });
});

describe('DEMO_MODE', () => {
  it('serves the bundled Spanish and Hindi fixtures for Maya’s moments, falls back to English otherwise, offline', async () => {
    const s = await seed((id) => buildMayaSession1(id), 'demo-chain-rule');
    const fetchSpy = vi.fn(noNetwork);
    const svc = service.createAiService({ env: { DEMO_MODE: '1', OPENAI_API_KEY: 'sk-x', ELEVENLABS_API_KEY: 'el' }, fetch: fetchSpy, limits: limits() });
    const sine = s.events.find((e) => e.type === 'misconception_corrected' && e.lectureMs >= 87_000 && e.lectureMs < 107_000)!;

    const en = await svc.getHelp(sine.id);
    const es = await svc.getHelp(sine.id, 'es');
    const hi = await svc.getHelp(sine.id, 'hi');
    const ko = await svc.getHelp(sine.id, 'ko');
    if (!en.ok || !es.ok || !hi.ok || !ko.ok) throw new Error('demo help failed');
    expect(es.language).toBe('es');
    expect(es.help.source).toBe('demo');
    expect(es.help.reexplain).toMatch(/derivada/);
    expect(es.help.mcq.options).toEqual(en.help.mcq.options); // identical math, same order
    expect(hi.language).toBe('hi');
    expect(hi.help.reexplain).toMatch(/[ऀ-ॿ]/);
    expect(ko).toMatchObject({ language: 'en', languageFallback: true });
    expect(ko.help.reexplain).toBe(en.help.reexplain);
    expect(await svc.localizedWhy(sine.id, 'es')).toMatch(/2x/);

    const gap = s.events.find((e) => e.type === 'unresolved_gap')!;
    const gapEs = await svc.getHelp(gap.id, 'es');
    expect(gapEs.ok && gapEs.language).toBe('es');

    const recap = await svc.recap(s.id, 'es');
    expect(recap.ok && recap.recap.language).toBe('es');
    expect(recap.ok && recap.recap.text).toContain('Este es tu resumen');
    expect(recap.ok && recap.recap.audioUrl).toBeUndefined(); // no voice offline: browser speech
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('read aloud in the student’s language', () => {
  it('speaks the translated explanation with a multilingual voice, cached per language', async () => {
    const s = await seed();
    const ttsDir = join(dir, 'tts-i18n');
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;
    // Help from the fake provider (overriding the Gemini key's provider); the voice is ElevenLabs.
    const svc = service.createAiService({
      env: { GEMINI_API_KEY: 'g', ELEVENLABS_API_KEY: 'el' },
      provider: createFakeProvider(),
      fetch: fetchMock,
      limits: limits(),
      ttsDir,
    });
    const fake = service.createAiService({ env: FAKE_ENV, limits: limits(), fetch: noNetwork });
    expect((await fake.getHelp(s.gap.id, 'es')).ok).toBe(true);

    // 409 until the translation exists for that language (speak never generates a card).
    expect(await svc.speak(s.gap.id, 'ko')).toMatchObject({ ok: false, status: 409 });
    const es = await svc.speak(s.gap.id, 'es');
    expect(es.ok).toBe(true);
    expect(bodies[0]).toMatchObject({ model_id: 'eleven_flash_v2_5', language_code: 'es' });
    expect(String(bodies[0].text).startsWith('[es] ')).toBe(true);
    await svc.speak(s.gap.id, 'es');
    expect(bodies).toHaveLength(1); // served from disk
    await svc.speak(s.gap.id, 'en');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ text: expect.any(String), model_id: 'eleven_flash_v2_5' });
    expect(readdirSync(ttsDir).filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
  });
});

describe('session recap', () => {
  it('404 for an unknown session', async () => {
    const svc = service.createAiService({ env: FAKE_ENV, limits: limits(), fetch: noNetwork });
    expect(await svc.recap('nope', 'en')).toMatchObject({ ok: false, status: 404 });
  });

  it('English: the deterministic template, no provider call, and an audio URL only with a voice', async () => {
    const s = await seed();
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(), fetch: noNetwork });
    const r = await svc.recap(s.id, 'en');
    if (!r.ok) throw new Error(r.error);
    expect(r.recap.text).toContain('1 correction, 1 gap and no breakthroughs');
    expect(r.recap.source).toBe('template');
    expect(r.recap.audioUrl).toBeUndefined();
    expect(provider.polishRecap).not.toHaveBeenCalled();

    const voiced = service.createAiService({ env: { ELEVENLABS_API_KEY: 'el' }, provider, limits: limits(), fetch: noNetwork });
    const withVoice = await voiced.recap(s.id, 'en');
    expect(withVoice.ok && withVoice.recap.audioUrl).toBe(`/api/sessions/${s.id}/recap/audio`);
  });

  it('other languages: translated by the provider (cached); the fake tags it', async () => {
    const s = await seed();
    const provider = spy();
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(), fetch: noNetwork });
    const r = await svc.recap(s.id, 'ko');
    if (!r.ok) throw new Error(r.error);
    expect(r.recap.language).toBe('ko');
    expect(r.recap.source).toBe('ai');
    expect(r.recap.text.startsWith('[ko] Here’s your recap')).toBe(true);
    await svc.recap(s.id, 'ko');
    expect(provider.polishRecap).toHaveBeenCalledTimes(1);
  });

  it('a failed translation uses the local template (Spanish) or English with a note', async () => {
    const s = await seed();
    const provider = spy();
    provider.polishRecap.mockRejectedValue(new Error('down'));
    const svc = service.createAiService({ env: FAKE_ENV, provider, limits: limits(), fetch: noNetwork });
    const es = await svc.recap(s.id, 'es');
    expect(es.ok && es.recap).toMatchObject({ language: 'es', source: 'template' });
    const fr = await svc.recap(s.id, 'fr');
    expect(fr.ok && fr.recap).toMatchObject({ language: 'en', languageFallback: true });
  });

  it('speaks the recap through the TTS disk cache', async () => {
    const s = await seed();
    const ttsDir = join(dir, 'tts-recap');
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    ) as unknown as typeof fetch;
    const svc = service.createAiService({ env: { OPENAI_API_KEY: 'sk' }, provider: createFakeProvider(), fetch: fetchMock, limits: limits(), ttsDir });
    const a = await svc.speakRecap(s.id, 'en');
    expect(a.ok).toBe(true);
    await svc.speakRecap(s.id, 'en');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(ttsDir)).toBe(true);
    expect(await svc.speakRecap('nope', 'en')).toMatchObject({ ok: false, status: 404 });
    const quiet = service.createAiService({ env: FAKE_ENV, limits: limits(), fetch: noNetwork });
    expect(await quiet.speakRecap(s.id, 'en')).toMatchObject({ ok: false, status: 503 });
  });
});
