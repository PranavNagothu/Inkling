// Read aloud: the state machine behind components/useReadAloud (client-safe, no React, no DOM
// globals — speechSynthesis, Audio, fetch and timers are injected so it is unit-tested with stubs).
//
// iPad Safari only lets a page speak (speechSynthesis.speak) or play media from inside a user
// gesture, and a speak() that is refused fails silently: no onstart, no onend, no error. So:
//   • when the page already knows the server has no voice (AiStatus.tts === false), or an earlier
//     request said so (503), speak() is called synchronously inside the tap;
//   • with a server voice, the Audio element is created and unlocked (a silent clip played) inside
//     the tap, and the fetched mp3 is later played on that same element;
//   • after every speak() a watchdog (SPEECH_WATCHDOG_MS) checks that speech actually started
//     (onstart or onboundary). If not, it cancels and shows a short hint instead of leaving the
//     button on "Stop reading" forever. A fallback that ran outside the tap says "Tap again", and
//     the next tap speaks in the browser synchronously.

export type ReadAloudState = "idle" | "loading" | "speaking" | "error";

export interface ReadAloudView {
  state: ReadAloudState;
  /** Which voice is (or was last) reading: "Browser voice", "ElevenLabs", … */
  voice: string | null;
  /** Shown with the "error" state. */
  hint: string | null;
}

export const SPEECH_WATCHDOG_MS = 800;
export const HINT_RETRY = "Tap again to hear it.";
export const HINT_NO_VOICE = "Voice unavailable on this device.";
export const HINT_UNSUPPORTED = "Read aloud isn’t available in this browser.";
export const BROWSER_VOICE = "Browser voice";

/** 10 ms of silence (8 kHz, 8-bit mono WAV): played inside the tap to unlock the element on iOS. */
export const SILENT_WAV =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

type Handler = ((ev: never) => unknown) | null;

/** The parts of SpeechSynthesisUtterance used here. */
export interface UtteranceLike {
  rate: number;
  onstart: Handler;
  onboundary: Handler;
  onend: Handler;
  onerror: Handler;
}

/** The parts of window.speechSynthesis used here. */
export interface SpeechLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  readonly speaking?: boolean;
  readonly pending?: boolean;
}

/** The parts of HTMLAudioElement used here. */
export interface AudioLike {
  src: string;
  play(): Promise<void>;
  pause(): void;
  onended: Handler;
  onerror: Handler;
}

export interface ReadAloudDeps {
  /** null when the browser has no speechSynthesis. */
  speech: SpeechLike | null;
  createUtterance: ((text: string) => UtteranceLike) | null;
  /** null when the browser has no Audio. */
  createAudio: (() => AudioLike) | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  onChange: (view: ReadAloudView) => void;
  /** Shared across the page: once the server said it has no voice (503), don't ask again. */
  memo: { noServerVoice: boolean };
  watchdogMs?: number;
}

export interface ReadAloudStart {
  text: string;
  /** POST endpoint returning audio/mpeg (503 when no voice is configured). */
  ttsUrl: string;
  /** From AiStatus.tts: false = speak in the browser right away; undefined = ask the server. */
  serverVoice?: boolean;
}

export interface ReadAloudController {
  /** Call directly from the click handler: everything up to speak()/play() runs synchronously. */
  start(options: ReadAloudStart): void;
  /** Stops and reports idle. */
  stop(): void;
  /** Stops without reporting anything (unmount). */
  cancel(): void;
}

export function createReadAloud(deps: ReadAloudDeps): ReadAloudController {
  const watchdogMs = deps.watchdogMs ?? SPEECH_WATCHDOG_MS;
  /** Bumped by every start/stop: callbacks from an older attempt are ignored. */
  let generation = 0;
  let abort: AbortController | null = null;
  let audio: AudioLike | null = null;
  let objectUrl: string | null = null;
  let spoke = false;
  let watchdog: unknown = null;
  /** The server voice failed on this page: the next tap goes straight to the browser voice. */
  let browserNext = false;

  const emit = (state: ReadAloudState, voice: string | null = null, hint: string | null = null) =>
    deps.onChange({ state, voice, hint });

  const clearWatchdog = () => {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    watchdog = null;
  };

  const releaseAudio = () => {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    audio = null;
    if (objectUrl) deps.revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  const cleanup = () => {
    generation++;
    clearWatchdog();
    abort?.abort();
    abort = null;
    releaseAudio();
    if (spoke) deps.speech?.cancel();
    spoke = false;
  };

  /** Speaks `text` with speechSynthesis; `inTap` = called synchronously from the click. */
  const speakInBrowser = (text: string, gen: number, inTap: boolean) => {
    const { speech, createUtterance } = deps;
    if (!speech || !createUtterance) {
      emit("error", null, HINT_UNSUPPORTED);
      return;
    }
    const utterance = createUtterance(text);
    utterance.rate = 1;
    let started = false;
    /** Given up on by the watchdog / an early error: its late events change nothing. */
    let abandoned = false;
    const current = () => gen === generation && !abandoned;
    const failed = () => {
      abandoned = true;
      clearWatchdog();
      spoke = false;
      browserNext = true;
      emit("error", null, inTap ? HINT_NO_VOICE : HINT_RETRY);
    };
    const markStarted = () => {
      if (!current()) return;
      started = true;
      clearWatchdog();
    };
    utterance.onstart = markStarted;
    utterance.onboundary = markStarted;
    utterance.onend = () => {
      if (!current()) return;
      clearWatchdog();
      spoke = false;
      emit("idle", BROWSER_VOICE);
    };
    utterance.onerror = () => {
      if (!current()) return;
      if (started) {
        clearWatchdog();
        spoke = false;
        emit("idle", BROWSER_VOICE);
      } else {
        speech.cancel();
        failed();
      }
    };
    // cancel() right before speak() can drop the new utterance on some iPads: only when busy.
    if (speech.speaking || speech.pending) speech.cancel();
    spoke = true;
    emit("speaking", BROWSER_VOICE);
    speech.speak(utterance);
    watchdog = deps.setTimeout(() => {
      watchdog = null;
      if (!current() || started) return;
      speech.cancel();
      failed();
    }, watchdogMs);
  };

  const start = ({ text, ttsUrl, serverVoice }: ReadAloudStart) => {
    cleanup();
    const gen = generation;
    if (serverVoice === false || deps.memo.noServerVoice || browserNext) {
      speakInBrowser(text, gen, true);
      return;
    }

    // Server voice: make the element now, inside the tap, and play a silent clip on it so iOS
    // lets the same element play the real audio once the request resolves.
    const el = deps.createAudio?.() ?? null;
    if (el) {
      el.src = SILENT_WAV;
      el.play().catch(() => {});
    }
    audio = el;
    const ctrl = new AbortController();
    abort = ctrl;
    emit("loading");

    let fellBack = false;
    const fallBack = () => {
      if (gen !== generation || fellBack) return;
      fellBack = true;
      browserNext = true;
      releaseAudio();
      speakInBrowser(text, gen, false);
    };

    void (async () => {
      try {
        const res = await deps.fetch(ttsUrl, { method: "POST", signal: ctrl.signal });
        if (gen !== generation) return;
        if (!res.ok) {
          if (res.status === 503) deps.memo.noServerVoice = true;
          fallBack();
          return;
        }
        const blob = await res.blob();
        if (gen !== generation) return;
        const player = audio ?? deps.createAudio?.() ?? null;
        if (!player) {
          fallBack();
          return;
        }
        audio = player;
        objectUrl = deps.createObjectURL(blob);
        player.onended = () => {
          if (gen === generation) emit("idle", res.headers.get("x-voice") || "AI voice");
        };
        player.onerror = fallBack;
        player.src = objectUrl;
        emit("speaking", res.headers.get("x-voice") || "AI voice");
        await player.play();
      } catch {
        if (ctrl.signal.aborted) return;
        fallBack();
      }
    })();
  };

  return {
    start,
    stop() {
      cleanup();
      emit("idle");
    },
    cancel: cleanup,
  };
}
