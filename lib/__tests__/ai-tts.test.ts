import { describe, expect, it, vi } from 'vitest';
import { MAX_TTS_CHARS, buildTtsRequest, selectTts, synthesizeSpeech, ttsCacheKey, ttsLabel } from '../ai/tts';

describe('selectTts', () => {
  it('prefers ElevenLabs, then OpenAI, else none', () => {
    expect(selectTts({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'sk' }).tts).toMatchObject({
      kind: 'elevenlabs',
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      model: 'eleven_flash_v2_5',
    });
    expect(selectTts({ OPENAI_API_KEY: 'sk' }).tts).toMatchObject({ kind: 'openai', voice: 'alloy', model: 'gpt-4o-mini-tts' });
    const none = selectTts({ OPENAI_API_KEY: '' });
    expect(none.tts).toBeNull();
    expect(none.reason).toMatch(/ELEVENLABS_API_KEY|OPENAI_API_KEY/);
  });

  it('voice and model are configurable', () => {
    expect(selectTts({ ELEVENLABS_API_KEY: 'el', ELEVENLABS_VOICE_ID: 'voice123', ELEVENLABS_MODEL: 'eleven_multilingual_v2' }).tts).toMatchObject({
      voiceId: 'voice123',
      model: 'eleven_multilingual_v2',
    });
    expect(selectTts({ OPENAI_API_KEY: 'sk', OPENAI_TTS_VOICE: 'nova', OPENAI_TTS_MODEL: 'tts-1' }).tts).toMatchObject({
      voice: 'nova',
      model: 'tts-1',
    });
  });

  it('is off (browser voice) in tests, with the fake provider, and in demo mode', () => {
    expect(selectTts({ ELEVENLABS_API_KEY: 'el', AI_PROVIDER: 'fake' }).tts).toBeNull();
    expect(selectTts({ OPENAI_API_KEY: 'sk', INKLING_DISABLE_AI: '1' }).tts).toBeNull();
    expect(selectTts({ OPENAI_API_KEY: 'sk', DEMO_MODE: '1' }).tts).toBeNull();
  });

  it('rejects a voice id that could escape the URL path', () => {
    expect(selectTts({ ELEVENLABS_API_KEY: 'el', ELEVENLABS_VOICE_ID: '../../admin?x=1' }).tts).toMatchObject({
      voiceId: '21m00Tcm4TlvDq8ikWAM',
    });
  });
});

describe('buildTtsRequest', () => {
  it('ElevenLabs: voice in the path, xi-api-key header, mp3 output', () => {
    const tts = selectTts({ ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'v1' }).tts!;
    const { url, init } = buildTtsRequest(tts, 'Hello there.');
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=mp3_44100_128');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('el-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' });
  });

  it('OpenAI: /audio/speech with bearer auth and mp3 format', () => {
    const tts = selectTts({ OPENAI_API_KEY: 'sk-k' }).tts!;
    const { url, init } = buildTtsRequest(tts, 'Hello.');
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-k');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hello.', response_format: 'mp3' });
  });

  it('caps the text it sends', () => {
    const tts = selectTts({ OPENAI_API_KEY: 'sk-k' }).tts!;
    const body = JSON.parse(buildTtsRequest(tts, 'a'.repeat(5000)).init.body as string);
    expect(body.input.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
  });
});

describe('ttsCacheKey / ttsLabel', () => {
  it('depends on voice, model and text', () => {
    const a = selectTts({ OPENAI_API_KEY: 'sk' }).tts!;
    const b = selectTts({ OPENAI_API_KEY: 'sk', OPENAI_TTS_VOICE: 'nova' }).tts!;
    expect(ttsCacheKey(a, 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(ttsCacheKey(a, 'x')).not.toBe(ttsCacheKey(b, 'x'));
    expect(ttsCacheKey(a, 'x')).not.toBe(ttsCacheKey(a, 'y'));
    expect(ttsCacheKey(a, ' x  ')).toBe(ttsCacheKey(a, 'x'));
    expect(ttsLabel(a)).toBe('OpenAI · alloy');
    expect(ttsLabel(selectTts({ ELEVENLABS_API_KEY: 'el' }).tts!)).toBe('ElevenLabs');
  });
});

describe('synthesizeSpeech', () => {
  const tts = selectTts({ OPENAI_API_KEY: 'sk' }).tts!;

  it('returns the audio bytes', async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } }));
    const bytes = await synthesizeSpeech(tts, 'Hi.', { fetch: f as unknown as typeof fetch });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0x49, 0x44, 0x33]);
  });

  it('retries a 429 once, then fails on errors or non-audio answers', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }));
    await expect(synthesizeSpeech(tts, 'Hi.', { fetch: f as unknown as typeof fetch, backoffMs: 0 })).resolves.toHaveLength(1);
    const bad = vi.fn(async () => new Response('{"error":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(synthesizeSpeech(tts, 'Hi.', { fetch: bad as unknown as typeof fetch })).rejects.toThrow(/audio/);
    const denied = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(synthesizeSpeech(tts, 'Hi.', { fetch: denied as unknown as typeof fetch })).rejects.toThrow(/401/);
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
