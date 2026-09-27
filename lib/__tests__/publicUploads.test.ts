import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Lecture } from '../types';

// POST /api/lectures in DEMO_MODE with and without PUBLIC_UPLOADS (the opt-in public upload
// switch): 403 when off; when on, accepted with a smaller cap, per-IP and daily rate limits, and
// auto-transcribe still refused. On a throwaway SQLite file + upload folder.
const dir = mkdtempSync(join(tmpdir(), 'inkling-public-upload-'));
process.env.INKLING_DB_PATH = join(dir, 'test.db');
process.env.INKLING_UPLOAD_DIR = join(dir, 'uploads');

let upload: typeof import('../../app/api/lectures/route');
let transcribe: typeof import('../../app/api/lectures/[id]/transcribe/route');
let limits: typeof import('../publicUploads');
let demoMode: typeof import('../demoMode');
let getLecture: typeof import('../lecture')['getLecture'];

const ENV_KEYS = ['DEMO_MODE', 'PUBLIC_UPLOADS', 'PUBLIC_UPLOAD_MAX_MB', 'PUBLIC_UPLOAD_DAILY_CAP'] as const;

beforeAll(async () => {
  upload = await import('../../app/api/lectures/route');
  transcribe = await import('../../app/api/lectures/[id]/transcribe/route');
  limits = await import('../publicUploads');
  demoMode = await import('../demoMode');
  ({ getLecture } = await import('../lecture'));
});

beforeEach(() => limits.resetPublicUploadLimits());
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOST = 'localhost:3000';

/** A WAV header followed by `size - 12` bytes of padding. */
function wav(size = 64): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x42);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WAVE'), 8);
  return bytes;
}
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nThe chain rule\n';

async function uploadRequest(
  opts: { media?: Uint8Array; captions?: string; ip?: string; contentLength?: number } = {},
): Promise<Request> {
  const form = new FormData();
  form.set('title', 'Visitor lecture');
  form.set('durationMs', '2000');
  form.set('media', new File([(opts.media ?? wav()) as BlobPart], 'talk.wav', { type: 'audio/wav' }));
  if (opts.captions) form.set('captions', new File([opts.captions], 'talk.vtt', { type: 'text/vtt' }));
  const encoded = new Request(`http://${HOST}/api/lectures`, { method: 'POST', body: form });
  const body = await encoded.arrayBuffer();
  return new Request(`http://${HOST}/api/lectures`, {
    method: 'POST',
    body,
    headers: {
      host: HOST,
      origin: `http://${HOST}`,
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(opts.contentLength ?? body.byteLength),
      'x-forwarded-for': opts.ip ?? '203.0.113.7',
    },
  });
}

const publicDemo = (extra: Record<string, string> = {}) => {
  process.env.DEMO_MODE = '1';
  process.env.PUBLIC_UPLOADS = '1';
  Object.assign(process.env, extra);
};

describe('publicUploadsEnabled / limits from env', () => {
  it('is on only with DEMO_MODE and PUBLIC_UPLOADS, and reads the caps', () => {
    expect(demoMode.publicUploadsEnabled({ PUBLIC_UPLOADS: '1' })).toBe(false);
    expect(demoMode.publicUploadsEnabled({ DEMO_MODE: '1' })).toBe(false);
    expect(demoMode.publicUploadsEnabled({ DEMO_MODE: '1', PUBLIC_UPLOADS: 'true' })).toBe(true);
    expect(demoMode.uploadsAllowed({})).toBe(true);
    expect(demoMode.uploadsAllowed({ DEMO_MODE: '1' })).toBe(false);
    expect(demoMode.uploadsAllowed({ DEMO_MODE: '1', PUBLIC_UPLOADS: '1' })).toBe(true);
    expect(demoMode.publicUploadMaxMb({})).toBe(50);
    expect(demoMode.publicUploadMaxMb({ PUBLIC_UPLOAD_MAX_MB: '20' })).toBe(20);
    expect(demoMode.publicUploadMaxMb({ PUBLIC_UPLOAD_MAX_MB: 'lots' })).toBe(50);
    expect(demoMode.publicUploadMaxMb({ PUBLIC_UPLOAD_MAX_MB: '9999' })).toBe(300);
    expect(demoMode.publicUploadDailyCap({})).toBe(50);
    expect(demoMode.publicUploadDailyCap({ PUBLIC_UPLOAD_DAILY_CAP: '5' })).toBe(5);
  });
});

describe('POST /api/lectures in DEMO_MODE', () => {
  it('refuses uploads (403) when PUBLIC_UPLOADS is off', async () => {
    process.env.DEMO_MODE = '1';
    const res = await upload.POST(await uploadRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(demoMode.UPLOAD_DEMO_MESSAGE);
  });

  it('accepts a recording with captions when PUBLIC_UPLOADS is on', async () => {
    publicDemo();
    const res = await upload.POST(await uploadRequest({ captions: VTT }));
    expect(res.status).toBe(201);
    const { lecture } = (await res.json()) as { lecture: Lecture };
    expect(lecture).toMatchObject({ title: 'Visitor lecture', transcriptSource: 'captions', mediaType: 'audio' });
    const record = await getLecture(lecture.id);
    expect(existsSync(resolve(process.cwd(), record!.mediaPath))).toBe(true);
  });

  it('caps each recording at PUBLIC_UPLOAD_MAX_MB (413)', async () => {
    publicDemo({ PUBLIC_UPLOAD_MAX_MB: '1' });
    const tooBig = await upload.POST(await uploadRequest({ media: wav(1024 * 1024 + 1024) }));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toMatch(/at most 1 MB/);
    // Declared too large: refused before the body is read.
    const declared = await upload.POST(await uploadRequest({ contentLength: 10 * 1024 * 1024 }));
    expect(declared.status).toBe(413);
  });

  it('rate-limits per IP (3 an hour) with 429 and Retry-After', async () => {
    publicDemo();
    for (let i = 0; i < 3; i++) expect((await upload.POST(await uploadRequest({ ip: '198.51.100.1' }))).status).toBe(201);
    const limited = await upload.POST(await uploadRequest({ ip: '198.51.100.1' }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another visitor is unaffected.
    expect((await upload.POST(await uploadRequest({ ip: '198.51.100.2' }))).status).toBe(201);
  });

  it('stops at the global daily cap (429)', async () => {
    publicDemo({ PUBLIC_UPLOAD_DAILY_CAP: '2' });
    expect((await upload.POST(await uploadRequest({ ip: '192.0.2.1' }))).status).toBe(201);
    expect((await upload.POST(await uploadRequest({ ip: '192.0.2.2' }))).status).toBe(201);
    const capped = await upload.POST(await uploadRequest({ ip: '192.0.2.3' }));
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toMatch(/today/);
  });

  it('still refuses auto-transcribe (403) with PUBLIC_UPLOADS on', async () => {
    publicDemo();
    const { lecture } = (await (await upload.POST(await uploadRequest())).json()) as { lecture: Lecture };
    const res = await transcribe.POST(
      new Request(`http://${HOST}/api/lectures/${lecture.id}/transcribe`, {
        method: 'POST',
        headers: { host: HOST, origin: `http://${HOST}` },
      }),
      { params: Promise.resolve({ id: lecture.id }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(demoMode.TRANSCRIBE_DEMO_MESSAGE);
  });

  it('keeps refusing cross-site uploads', async () => {
    publicDemo();
    const req = await uploadRequest();
    const headers = new Headers(req.headers);
    headers.set('origin', 'https://evil.example');
    const res = await upload.POST(new Request(req, { headers }));
    expect(res.status).toBe(403);
  });
});
