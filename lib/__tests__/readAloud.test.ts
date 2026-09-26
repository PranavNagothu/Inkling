import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HINT_NO_VOICE,
  HINT_RETRY,
  HINT_UNSUPPORTED,
  SPEECH_WATCHDOG_MS,
  createReadAloud,
  type AudioLike,
  type ReadAloudDeps,
  type ReadAloudView,
  type UtteranceLike,
} from '../readAloud';

// The Read aloud state machine (components/useReadAloud wraps it for React), with stubbed
// speechSynthesis / Audio / fetch and fake timers.

class FakeUtterance implements UtteranceLike {
  rate = 1;
  onstart: UtteranceLike['onstart'] = null;
  onboundary: UtteranceLike['onboundary'] = null;
  onend: UtteranceLike['onend'] = null;
  onerror: UtteranceLike['onerror'] = null;
  constructor(readonly text: string) {}
}

class FakeAudio implements AudioLike {
  src = '';
  onended: AudioLike['onended'] = null;
  onerror: AudioLike['onerror'] = null;
  played: string[] = [];
  paused = 0;
  failPlayOf: string | null = null;
  play() {
    this.played.push(this.src);
    return this.src === this.failPlayOf ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
  }
  pause() {
    this.paused++;
  }
}

/** A tick of the microtask queue (fetch/blob/play promises), without advancing timers. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(over: Partial<ReadAloudDeps> = {}) {
  const views: ReadAloudView[] = [];
  const utterances: FakeUtterance[] = [];
  const audios: FakeAudio[] = [];
  const speech = { speak: vi.fn((u: UtteranceLike) => void u), cancel: vi.fn(), speaking: false, pending: false };
  const fetch = vi.fn<ReadAloudDeps['fetch']>();
  const memo = { noServerVoice: false };
  const deps: ReadAloudDeps = {
    speech,
    createUtterance: (text) => {
      const u = new FakeUtterance(text);
      utterances.push(u);
      return u;
    },
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    fetch,
    createObjectURL: () => 'blob:tts-1',
    revokeObjectURL: vi.fn(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    onChange: (v) => views.push(v),
    memo,
    ...over,
  };
  const ctrl = createReadAloud(deps);
  const last = () => views[views.length - 1];
  return { ctrl, deps, views, last, utterances, audios, speech, fetch, memo };
}

const mp3 = (voice = 'ElevenLabs') =>
  new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200, headers: { 'x-voice': voice } });
const TEXT = 'The chain rule multiplies by the derivative of the inside.';
const URL_ = '/api/events/e1/tts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('no server voice (known before the tap)', () => {
  it('speaks synchronously inside the tap, without asking the server', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    // Synchronous: speak() ran before start() returned (iPad Safari needs the user gesture).
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    expect(t.utterances[0].text).toBe(TEXT);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.last()).toEqual({ state: 'speaking', voice: 'Browser voice', hint: null });
  });

  it('normal flow: onstart → keeps speaking past the watchdog; onend → idle', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    t.utterances[0].onstart?.({} as never);
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS * 3);
    expect(t.last().state).toBe('speaking');
    expect(t.speech.cancel).not.toHaveBeenCalled();
    t.utterances[0].onend?.({} as never);
    expect(t.last()).toEqual({ state: 'idle', voice: 'Browser voice', hint: null });
  });

  it('a boundary event also counts as started', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    t.utterances[0].onboundary?.({} as never);
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS * 2);
    expect(t.last().state).toBe('speaking');
  });

  it('watchdog: nothing starts within ~800 ms → cancel and an error hint instead of "Stop reading"', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS - 1);
    expect(t.last().state).toBe('speaking');
    vi.advanceTimersByTime(1);
    expect(t.speech.cancel).toHaveBeenCalled();
    expect(t.last()).toEqual({ state: 'error', voice: null, hint: HINT_NO_VOICE });
    // A late onstart/onend from the abandoned utterance changes nothing.
    t.utterances[0].onstart?.({} as never);
    t.utterances[0].onend?.({} as never);
    expect(t.last().state).toBe('error');
  });

  it('tapping again after the error tries again (synchronously) and can succeed', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS);
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    expect(t.speech.speak).toHaveBeenCalledTimes(2);
    expect(t.last()).toEqual({ state: 'speaking', voice: 'Browser voice', hint: null });
    t.utterances[1].onstart?.({} as never);
    t.utterances[1].onend?.({} as never);
    expect(t.last().state).toBe('idle');
  });

  it('an error before starting shows the hint; an error after starting just stops', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    t.utterances[0].onerror?.({} as never);
    expect(t.last()).toEqual({ state: 'error', voice: null, hint: HINT_NO_VOICE });
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS * 2); // the watchdog was cleared
    expect(t.views.filter((v) => v.state === 'error')).toHaveLength(1);

    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    t.utterances[1].onstart?.({} as never);
    t.utterances[1].onerror?.({} as never);
    expect(t.last().state).toBe('idle');
  });

  it('no speechSynthesis at all → the "not available in this browser" error', () => {
    const t = setup({ speech: null, createUtterance: null });
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    expect(t.last()).toEqual({ state: 'error', voice: null, hint: HINT_UNSUPPORTED });
  });

  it('only cancels a queue that is busy (cancel right before speak drops speech on some iPads)', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    expect(t.speech.cancel).not.toHaveBeenCalled();
    t.speech.speaking = true;
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    expect(t.speech.cancel).toHaveBeenCalled();
  });

  it('stop() cancels speech and ignores the old utterance afterwards', () => {
    const t = setup();
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: false });
    t.ctrl.stop();
    expect(t.speech.cancel).toHaveBeenCalled();
    expect(t.last()).toEqual({ state: 'idle', voice: null, hint: null });
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS * 2);
    expect(t.last().state).toBe('idle');
  });
});

describe('server voice', () => {
  it('creates and unlocks the audio element inside the tap, then plays the fetched mp3 on it', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(mp3());
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    // Synchronously, before the fetch resolves: one element, already played once (a silent clip).
    expect(t.audios).toHaveLength(1);
    expect(t.audios[0].played).toHaveLength(1);
    expect(t.audios[0].played[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(t.last()).toEqual({ state: 'loading', voice: null, hint: null });
    expect(t.fetch).toHaveBeenCalledWith(URL_, expect.objectContaining({ method: 'POST' }));

    await flush();
    expect(t.audios).toHaveLength(1); // the same, gesture-unlocked element
    expect(t.audios[0].played[1]).toBe('blob:tts-1');
    expect(t.last()).toEqual({ state: 'speaking', voice: 'ElevenLabs', hint: null });
    expect(t.speech.speak).not.toHaveBeenCalled();
    t.audios[0].onended?.({} as never);
    expect(t.last().state).toBe('idle');
  });

  it('unknown availability behaves like a server voice (asks the server first)', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(mp3('OpenAI TTS'));
    t.ctrl.start({ text: TEXT, ttsUrl: URL_ });
    await flush();
    expect(t.last()).toEqual({ state: 'speaking', voice: 'OpenAI TTS', hint: null });
  });

  it('503 → browser voice now, and synchronously (no fetch) on every later tap', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(new Response('{}', { status: 503 }));
    t.ctrl.start({ text: TEXT, ttsUrl: URL_ });
    await flush();
    expect(t.memo.noServerVoice).toBe(true);
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    expect(t.audios[0].paused).toBeGreaterThan(0);
    t.utterances[0].onstart?.({} as never);
    t.utterances[0].onend?.({} as never);

    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.speech.speak).toHaveBeenCalledTimes(2);
  });

  it('a failed fallback outside the tap (watchdog) says "tap again", and the next tap speaks synchronously', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(new Response('{}', { status: 502 }));
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    await flush();
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS);
    expect(t.last()).toEqual({ state: 'error', voice: null, hint: HINT_RETRY });

    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    expect(t.fetch).toHaveBeenCalledTimes(1); // not asked again
    expect(t.speech.speak).toHaveBeenCalledTimes(2);
    expect(t.last().state).toBe('speaking');
  });

  it('play() refused (autoplay) → falls back to the browser voice once, with the watchdog', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(mp3());
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    t.audios[0].failPlayOf = 'blob:tts-1';
    await flush();
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    // The element's own error event after the rejected play() does not start a second fallback.
    t.audios[0].onerror?.({} as never);
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    expect(t.last()).toEqual({ state: 'speaking', voice: 'Browser voice', hint: null });
    expect(t.deps.revokeObjectURL).toHaveBeenCalledWith('blob:tts-1');
  });

  it('a network error falls back to the browser voice', async () => {
    const t = setup();
    t.fetch.mockRejectedValue(new TypeError('network'));
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    await flush();
    expect(t.speech.speak).toHaveBeenCalledTimes(1);
    expect(t.last().voice).toBe('Browser voice');
  });

  it('stop() while loading aborts the request and ignores its answer', async () => {
    const t = setup();
    let resolve!: (r: Response) => void;
    t.fetch.mockImplementation(
      (_url, init) =>
        new Promise<Response>((res, rej) => {
          resolve = res;
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    t.ctrl.stop();
    resolve(mp3());
    await flush();
    expect(t.last()).toEqual({ state: 'idle', voice: null, hint: null });
    expect(t.speech.speak).not.toHaveBeenCalled();
    expect(t.audios[0].played).toHaveLength(1); // only the unlock clip
  });

  it('cancel() (unmount) stops everything without reporting a state', async () => {
    const t = setup();
    t.fetch.mockResolvedValue(mp3());
    t.ctrl.start({ text: TEXT, ttsUrl: URL_, serverVoice: true });
    const before = t.views.length;
    t.ctrl.cancel();
    await flush();
    expect(t.views).toHaveLength(before);
    expect(t.audios[0].paused).toBeGreaterThan(0);
  });
});
