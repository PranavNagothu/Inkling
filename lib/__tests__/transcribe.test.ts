import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/whisper-verbose.json';
import { TRANSCRIBE_MAX_BYTES, TranscribeError, selectTranscriber, transcribeFile } from '../transcribe';

// Mocked fetch only: nothing here touches the network.
const dir = mkdtempSync(join(tmpdir(), 'inkling-transcribe-'));
const audio = join(dir, 'lecture.mp3');
writeFileSync(audio, Buffer.from('ID3 fake mp3 bytes'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const GROQ = { GROQ_API_KEY: 'gsk_test' };

describe('selectTranscriber', () => {
  it('is off without a key, or with INKLING_DISABLE_AI=1', () => {
    expect(selectTranscriber({})).toBeNull();
    expect(selectTranscriber({ ...GROQ, INKLING_DISABLE_AI: '1' })).toBeNull();
    // The public demo never spends Whisper credits, even with a key set for the landing assistant.
    expect(selectTranscriber({ ...GROQ, DEMO_MODE: '1' })).toBeNull();
    expect(selectTranscriber({ OPENAI_API_KEY: '', GROQ_API_KEY: ' ' })).toBeNull();
  });

  it('prefers OpenAI Whisper; uses Groq Whisper when only GROQ_API_KEY is set', () => {
    expect(selectTranscriber({ OPENAI_API_KEY: 'sk-a', ...GROQ })).toMatchObject({
      provider: 'openai',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
    });
    expect(selectTranscriber(GROQ)).toMatchObject({
      provider: 'groq',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo',
      maxBytes: 25 * 1024 * 1024,
    });
  });

  it('GROQ_TRANSCRIBE_MODEL and GROQ_BASE_URL override the Groq defaults', () => {
    expect(selectTranscriber({ ...GROQ, GROQ_TRANSCRIBE_MODEL: 'whisper-large-v3', GROQ_BASE_URL: 'https://proxy.example/v1/' })).toMatchObject({
      url: 'https://proxy.example/v1/audio/transcriptions',
      model: 'whisper-large-v3',
    });
  });
});

describe('transcribeFile', () => {
  it('Groq: multipart upload with verbose_json + word timestamps, mapped to TranscriptWords', async () => {
    const f = vi.fn(async () => json(fixture));
    const words = await transcribeFile(audio, 'audio/mpeg', 18, { env: GROQ, fetch: f as unknown as typeof fetch });
    expect(words.slice(0, 2)).toEqual([
      { w: 'Okay,', startMs: 0, endMs: 420 },
      { w: 'today', startMs: 620, endMs: 980 },
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    const file = form.get('file') as File;
    expect(file.name).toBe('lecture.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(file.size).toBe(18);
  });

  it('OpenAI stays first when both keys are set', async () => {
    const f = vi.fn(async () => json(fixture));
    await transcribeFile(audio, 'audio/mpeg', 18, { env: { OPENAI_API_KEY: 'sk-a', ...GROQ }, fetch: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init.body as FormData).get('model')).toBe('whisper-1');
  });

  it('refuses files over the 25 MB upload limit before calling Groq, with a clear message', async () => {
    const f = vi.fn();
    const err = (await transcribeFile(audio, 'audio/mpeg', TRANSCRIBE_MAX_BYTES + 1, { env: GROQ, fetch: f as unknown as typeof fetch }).catch(
      (e: unknown) => e,
    )) as TranscribeError;
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/Groq/);
    expect(err.message).toMatch(/25 MB/);
    expect(err.message).toMatch(/captions/i);
    expect(f).not.toHaveBeenCalled();
  });

  it('maps a 413 from the service to the same clear error, and other failures to 502', async () => {
    const tooBig = vi.fn(async () => json({ error: { message: 'Request Entity Too Large' } }, 413));
    await expect(transcribeFile(audio, 'audio/mpeg', 18, { env: GROQ, fetch: tooBig as unknown as typeof fetch })).rejects.toMatchObject({
      status: 413,
      message: expect.stringMatching(/25 MB/),
    });
    const down = vi.fn(async () => json({ error: { message: 'boom' } }, 500));
    await expect(transcribeFile(audio, 'audio/mpeg', 18, { env: GROQ, fetch: down as unknown as typeof fetch })).rejects.toMatchObject({
      status: 502,
    });
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(transcribeFile(audio, 'audio/mpeg', 18, { env: GROQ, fetch: offline as unknown as typeof fetch })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('503 when nothing is configured; 422 when no speech was recognised', async () => {
    await expect(transcribeFile(audio, 'audio/mpeg', 18, { env: {} })).rejects.toMatchObject({ status: 503 });
    const empty = vi.fn(async () => json({ text: '', words: [], segments: [] }));
    await expect(transcribeFile(audio, 'audio/mpeg', 18, { env: GROQ, fetch: empty as unknown as typeof fetch })).rejects.toMatchObject({
      status: 422,
    });
  });
});
