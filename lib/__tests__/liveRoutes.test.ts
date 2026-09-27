import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Lecture, Session } from '../types';

// The Live lecture routes end to end on a throwaway SQLite file + upload folder: create, cue
// batches, the recording upload, same-origin and body limits, and DEMO_MODE's 403.
const dir = mkdtempSync(join(tmpdir(), 'inkling-live-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');
process.env.INKLING_UPLOAD_DIR = join(dir, 'uploads');
// DATABASE_URL comes from the vitest project: '' (SQLite) or pglite:memory (the postgres project).

type Routes = {
  create: typeof import('../../app/api/lectures/live/route');
  cues: typeof import('../../app/api/lectures/[id]/cues/route');
  recording: typeof import('../../app/api/lectures/[id]/recording/route');
};
let r: Routes;
let getLecture: typeof import('../lecture')['getLecture'];

beforeAll(async () => {
  r = {
    create: await import('../../app/api/lectures/live/route'),
    cues: await import('../../app/api/lectures/[id]/cues/route'),
    recording: await import('../../app/api/lectures/[id]/recording/route'),
  };
  ({ getLecture } = await import('../lecture'));
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HOST = 'localhost:3000';
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(path: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(`http://${HOST}${path}`, {
    method: 'POST',
    body,
    headers: { host: HOST, ...headers },
    // Node needs this for a streamed body; harmless otherwise.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}
const json = (path: string, data: unknown, headers: Record<string, string> = {}) =>
  post(path, JSON.stringify(data), { 'content-type': 'application/json', ...headers });

async function createLive(title = 'Linear algebra — live') {
  const res = await r.create.POST(json('/api/lectures/live', { title }));
  expect(res.status).toBe(201);
  return (await res.json()) as { lecture: Lecture; session: Session };
}

/** A tiny but real-looking WebM file (EBML magic + padding). */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0x42)]);

describe('POST /api/lectures/live', () => {
  it('creates a Live lecture (no media yet) and a session on it', async () => {
    const { lecture, session } = await createLive('  Week 5:\n eigenvalues ');
    expect(lecture).toMatchObject({
      title: 'Week 5: eigenvalues',
      transcriptSource: 'live',
      live: true,
      wordCount: 0,
      durationMs: 0,
      mediaType: 'audio',
    });
    expect(session).toMatchObject({ lectureId: lecture.id, title: 'Week 5: eigenvalues' });
    expect((await getLecture(lecture.id))!.mediaPath).toBe('');
  });

  it('defaults the title and validates the body', async () => {
    const res = await r.create.POST(json('/api/lectures/live', {}));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { lecture: Lecture }).lecture.title).toMatch(/^Live lecture — /);
    expect((await r.create.POST(json('/api/lectures/live', { title: 7 }))).status).toBe(400);
    expect((await r.create.POST(json('/api/lectures/live', ['x']))).status).toBe(400);
    expect((await r.create.POST(post('/api/lectures/live', '{nope', { 'content-type': 'application/json' }))).status).toBe(400);
    expect((await r.create.POST(post('/api/lectures/live', 'x'.repeat(17 * 1024)))).status).toBe(413);
  });

  it('refuses cross-site requests', async () => {
    const res = await r.create.POST(json('/api/lectures/live', { title: 'x' }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    // Same origin is fine.
    expect((await r.create.POST(json('/api/lectures/live', {}, { origin: `http://${HOST}` }))).status).toBe(201);
  });

  it('is disabled in DEMO_MODE with a friendly message', async () => {
    process.env.DEMO_MODE = '1';
    const res = await r.create.POST(json('/api/lectures/live', { title: 'x' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Live lecture is available when you run Inkling yourself.' });
  });
});

describe('POST /api/lectures/[id]/cues', () => {
  it('appends cues as the transcript, idempotently, and grows the length', async () => {
    const { lecture } = await createLive();
    const path = `/api/lectures/${lecture.id}/cues`;
    const first = [{ startMs: 1000, endMs: 2000, text: 'the chain rule' }];
    let res = await r.cues.POST(json(path, { cues: first, durationMs: 2500 }), ctx(lecture.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ wordCount: 3, lecture: { durationMs: 2500, wordCount: 3, live: true } });

    const second = [{ startMs: 2000, endMs: 3000, text: 'says differentiate outside' }];
    await r.cues.POST(json(path, { cues: second, durationMs: 3100 }), ctx(lecture.id));
    // A retry of the same batch (the response was lost) does not duplicate words.
    res = await r.cues.POST(json(path, { cues: second, durationMs: 3200 }), ctx(lecture.id));
    expect(await res.json()).toMatchObject({ wordCount: 6, lecture: { durationMs: 3200 } });

    const rec = (await getLecture(lecture.id))!;
    expect(rec.words.map((w) => w.w).join(' ')).toBe('the chain rule says differentiate outside');
    expect(rec.words[0]).toEqual({ w: 'the', startMs: 1000, endMs: 1333 });
    expect(rec.lecture.transcriptSource).toBe('live');
  });

  it('validates input and only accepts Live lectures', async () => {
    const { lecture } = await createLive();
    const path = `/api/lectures/${lecture.id}/cues`;
    expect((await r.cues.POST(json(path, { cues: [{ startMs: 5, endMs: 1, text: 'x' }] }), ctx(lecture.id))).status).toBe(400);
    expect((await r.cues.POST(json(path, { cues: 'x' }), ctx(lecture.id))).status).toBe(400);
    expect((await r.cues.POST(post(path, 'x'.repeat(300 * 1024)), ctx(lecture.id))).status).toBe(413);
    expect((await r.cues.POST(json('/api/lectures/l_missing/cues', { cues: [] }), ctx('l_missing'))).status).toBe(404);
    // The demo lecture is not a Live lecture.
    const demo = await r.cues.POST(
      json('/api/lectures/demo-chain-rule/cues', { cues: [{ startMs: 0, endMs: 10, text: 'x' }] }),
      ctx('demo-chain-rule'),
    );
    expect(demo.status).toBe(409);
    expect((await r.cues.POST(json(path, { cues: [] }, { origin: 'http://evil.example' }), ctx(lecture.id))).status).toBe(403);
  });

  it('is disabled in DEMO_MODE', async () => {
    const { lecture } = await createLive();
    process.env.DEMO_MODE = 'true';
    const res = await r.cues.POST(json(`/api/lectures/${lecture.id}/cues`, { cues: [] }), ctx(lecture.id));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/lectures/[id]/recording', () => {
  it('stores the recording as the lecture media; then the lecture plays back like an upload', async () => {
    const { lecture } = await createLive();
    const res = await r.recording.POST(
      post(`/api/lectures/${lecture.id}/recording?durationMs=65000`, WEBM, { 'content-type': 'audio/webm;codecs=opus' }),
      ctx(lecture.id),
    );
    expect(res.status).toBe(201);
    const saved = ((await res.json()) as { lecture: Lecture }).lecture;
    expect(saved).toMatchObject({ mime: 'audio/webm', mediaType: 'audio', durationMs: 65_000, transcriptSource: 'live' });
    expect(saved.live).toBeUndefined();
    const rec = (await getLecture(lecture.id))!;
    expect(rec.mediaPath).toMatch(/\.webm$/);
    expect(readFileSync(resolve(process.cwd(), rec.mediaPath))).toEqual(Buffer.from(WEBM));

    // Only once.
    const again = await r.recording.POST(
      post(`/api/lectures/${lecture.id}/recording?durationMs=1`, WEBM, { 'content-type': 'audio/webm' }),
      ctx(lecture.id),
    );
    expect(again.status).toBe(409);
  });

  it('checks type, magic bytes, length and size — and leaves no file behind on failure', async () => {
    const { lecture } = await createLive();
    const path = `/api/lectures/${lecture.id}/recording`;
    const send = (body: BodyInit, type: string, q = '?durationMs=1000', headers: Record<string, string> = {}) =>
      r.recording.POST(post(path + q, body, { 'content-type': type, ...headers }), ctx(lecture.id));
    expect((await send(WEBM, 'video/quicktime')).status).toBe(415);
    expect((await send(WEBM, 'audio/webm', '?durationMs=abc')).status).toBe(400);
    expect((await send(WEBM, 'audio/mp4')).status).toBe(400); // WebM bytes declared as MP4
    expect((await send(new Uint8Array(0), 'audio/webm')).status).toBe(400);
    expect((await send(WEBM, 'audio/webm', '?durationMs=1000', { 'content-length': String(400 * 1024 * 1024) })).status).toBe(413);
    expect((await send(WEBM, 'audio/webm', '?durationMs=1000', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await getLecture(lecture.id))!.lecture.live).toBe(true);
    const uploads = join(dir, 'uploads');
    const { readdirSync } = await import('node:fs');
    const leftovers = existsSync(uploads) ? readdirSync(uploads).filter((f) => f.endsWith('.webm') || f.endsWith('.m4a')) : [];
    // Only the successful recording from the previous test is on disk.
    expect(leftovers.length).toBe(1);
  });

  it('is disabled in DEMO_MODE', async () => {
    const { lecture } = await createLive();
    process.env.DEMO_MODE = 'yes';
    const res = await r.recording.POST(
      post(`/api/lectures/${lecture.id}/recording?durationMs=1000`, WEBM, { 'content-type': 'audio/webm' }),
      ctx(lecture.id),
    );
    expect(res.status).toBe(403);
  });
});
